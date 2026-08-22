# Coda — notes for AI sessions

Browser-based node-graph editor for connectome analysis. Prototype stage. See
[README.md](README.md) for the user-facing picture and
[docs/adding-a-node.md](docs/adding-a-node.md) for the main extension point.

## Commands

```bash
pnpm dev            # vite dev server
pnpm test           # vitest, 1300 tests
pnpm test:watch
pnpm typecheck      # tsc -b --noEmit
pnpm lint           # eslint, includes the core/UI boundary rule
pnpm build          # tsc -b && vite build
```

Node is at `/opt/homebrew/bin/node` (Node 26, installed via brew). Node 25+ dropped
bundled corepack, so pnpm was installed with `npm i -g pnpm`.

## Invariants — don't break these silently

1. **`src/core` and `src/data` are headless.** No React, no zustand, no store, no UI
   imports. Enforced by a lint rule in `eslint.config.js`. The reason is a future non-React
   consumer (CLI runner, Python-side executor over the same graph JSON), plus DOM-free unit
   tests.

2. **`inferOutputs` must never throw and must not fetch.** It runs on every graph
   mutation. Failures degrade to "unknown type", which silently kills column pickers.

   The corollary is that **something has to say when the degraded answer is worth redoing**.
   Dataset listings and discovered schemas arrive over the network, so inference runs against
   whatever `peekDatasets()`/`schemasFor()` have cached and, on a fresh session, that is
   nothing. `reportSourceLearned` (in `data/source.ts`, same channel idiom as
   `reportAuthFailure`) is what closes that loop: `NeuPrintSource` fires it when a listing
   lands and when discovery finishes, and `graphStore.afterSourceLearned` re-infers. Fire it
   for anything inference reads synchronously; it is not a data-changed event and invalidates
   nothing.

   What the gap looked like, since it is not obvious from a stack trace: a fresh tab, a
   MaleCNS workflow, a pipeline that ran to completion, and an Explore widget beside it saying
   "Connect a Dataset to browse its neurons". A dataset node on "Latest" reads its id out of
   `peekDatasets()`, so it published a Dataset type with **no dataset id** and the widget had
   nothing to load — while `evaluate` had the real value all along, which is why the run
   succeeded. It recovered on any edit at all, because `afterGraphChange` re-infers; that
   "everything fixes it" quality is the signature to recognise.

3. **Schema half and value half must agree.** Every op in `src/nodes/lib/tableOps.ts` has a
   `*Schema` and a `*Table` function side by side. If they disagree, downstream column
   pickers break only after a run. `tableOps.test.ts` asserts the pairing.

4. **Cache keys are provenance, not content** — `hash(type, params, upstream keys)`. So
   `evaluate` must be deterministic. Nodes depending on hidden mutable state need an
   explicit nonce param (see the Dataset node's `refresh`).

   `normalizeParams` excludes two kinds of param from the key: hidden ones (`visibleIf`
   false) and `presentational: true` ones. Mark a param presentational **only** if it
   cannot change what `evaluate` returns — every `out.*` viewer knob qualifies. Getting it
   wrong means a stale result silently survives an edit.

5. **Resolve column params via `ctx.column()` / `ctx.columns()`,** never
   `ctx.params.someColumn`. Infer, validate, evaluate and the cache key all rely on the
   same resolution; bypassing it desynchronises them.

   The corollary, and it cost a real bug: **an unresolved column is not grounds for
   `evaluate` to throw.** A viewer that passes its input through has no business blocking
   everything downstream because a picker is unset — and it cannot even be right about it,
   since a `core.pivot` upstream publishes no schema until it has run (`observesOutputSchema`)
   and none again after a reload. `out.scatter` refused there while holding the table whose
   numeric column its own error message then went on to list; `out.barChart` had carried the
   same refusal since long before, unnoticed because it had no node-level test. Both now pass
   through and let `validate` and the widget's empty state carry it. A refusal in an `out.*`
   `evaluate` should be about the _type_ it was handed ("Input is not a table") or about data
   the emitted artefact genuinely cannot be built without — not about a control.

   `validateColumnParams` draws three distinctions that all exist for the same reason — a
   check that cries wolf is how a real issue further down the list stops being read.
   **Unknown is not empty:** a port carrying no schema is skipped entirely, or every column
   param downstream of a Pivot warns at once about a table nobody has seen. **Optional means
   off, not first:** `resolveColumn` answers _undefined_ for an optional picker whose column
   vanished, so the ordinary `is gone — using "x"` names a fallback that will not be taken,
   which is a false statement rather than a loud one. **A default was never a decision:** an
   optional picker still holding the value the definition declared has no drift to report,
   which is what lets `out.scatter` declare `idColumn: 'neuronId'` — configuring nothing on a
   neuron table, meaning row positions elsewhere — without a badge either way. A column
   somebody _chose_ is still reported, optional or not: `out.network`'s link label drawing
   nothing is exactly the silent failure the check exists for.

6. **`cheap` vs `expensive` on a node is a real decision.** `cheap` re-runs automatically
   on every edit. A backend call marked `cheap` fires a request per keystroke.

7. **Selectors must not allocate.** The store is read through `useSyncExternalStore`, which
   compares snapshots by identity. `Scheduler.info()` returns a shared frozen `IDLE` object
   for exactly this reason; returning `{ state: 'idle' }` per call caused an infinite-loop
   warning. Select primitives, or memoise.

8. **A neuron id crosses the `DataSource` seam as text, never as a number.** `NeuronId` in
   `data/source.ts` is a `string` of decimal digits, and every request field that names neurons
   (`neuronIds`, `sourceIds`, `targetIds`, `neuronId`) is typed with it.

   `CellValue` is a JS number, so an `i64` column is really a float64. neuPrint's ids are nine
   to eleven digits and comfortably exact; a CAVE root id is eighteen and is not —
   `648518347529750614` parses to `648518347529750700`, which is a **different neuron**, with
   nothing anywhere to say so. Measured in R, the same id becomes `648518347529750528`: not
   merely lossy but lossy differently per language, so no downstream comparison can be trusted
   either.

   **Each source converts at its own edge**, and every conversion is now the exact one:
   `idList` in `neuprint/cypher.ts` splices the digits into Cypher as an integer literal so no
   float is ever formed; `precomputed/index.ts` hands them to `BigInt`, which is exact from a
   string and lossy from a number — so the shard hash it feeds was quietly wrong for a wide id
   before this; `MockSource.numericIds` converts back to the small integers its generated
   connectome is keyed by.

   **The rule lives in `src/core/ids.ts`, and that placement is the point.** `NeuronId`,
   `isNeuronId` (the grammar), `idText` (a cell → an id) and `compareIds` are one definition
   each, plus `numericId` for the inverse direction. They sit in `src/core` because it is the
   only layer every consumer reaches — the sources need the grammar, the nodes need the cell
   rule, both exporters need both, and `src/data` may not import `src/nodes` (invariant 1), so
   anywhere higher leaves somebody out. There is deliberately **no re-export**: a shim is how a
   symbol acquires a second spelling and then a third.

   That is worth saying because the rule was written four times before it was written once, and
   the copies had already drifted: two accepted a leading `-` and two did not, while the type's
   own documentation asserted a grammar no function enforced.

   **And it kept being written a fifth time, in the UI, where nothing enforces it.** Three sites
   converted an id to a `number` and were found together after one was reported: Explore's
   `neuronIdAt` (`Number(cell)`, so an eighteen-digit root id went into the `selection` param as
   `…857200`), `PartnerRow.neuronId` in `profileStats` (`toNumber`, and then
   `a.neuronId - b.neuronId` as a tie-break, which reports two adjacent wide ids as *equal*), and
   `NeuroglancerProfileFrame`'s `neuronId: number`, which becomes a neuroglancer segment.

   The Explore one is the instructive symptom, because it is precise and points nowhere near the
   cause: **`Hits` works and `Selected` is empty**. `Hits` is `selectRows(index, capped)` and never
   goes through the selection; `Selected` is `rowsWithIds(index, selection)`, matching a rounded
   string against exact ones. Worse, the *checkbox stayed ticked* — the widget compared its own
   rounded id against its own rounded id, so only the value crossing to `evaluate` was wrong.
   neuPrint's nine-to-eleven-digit ids are exact as doubles, which is why all three survived.

   The one remaining `Number(...)` on an id is `inputIds`' unwired branch, which is deliberate and
   documented there: `ID_ONLY_SCHEMA` declares `i64`, invariant 3 says the halves must agree, and
   `validate` warns about the ids that cannot survive it.

   **`idText` is the cell-level rule**, shared by `idColumn`, the connectivity traversal and the
   path decoder, so the ids a query is _built from_ cannot disagree with the ids a result is
   _keyed by_ — that disagreement shows up as edges silently missing from a hop rather than as
   an error. Note it deliberately does **not** apply the grammar: a `str` column holding `LC4`
   comes back as `'LC4'`, and callers differ in what they owe about it — `idsFromColumn` counts
   what it drops, the query builders drop silently. Sorting goes through `compareIds`, which is
   length-then-lexicographic: numeric order for non-negative integers of any width, where
   `Number(a) - Number(b)` reports two adjacent wide ids as equal.

   What this does **not** change is what a source _publishes_ as a **dtype**. neuPrint's ids are
   exact as doubles, so its `neuronId` column is `i64` and holds numbers; a CAVE source will
   declare `str`. `idColumn` reads either.

   **The column is called `neuronId`, and that is Coda's word rather than any backend's.** It
   used to be `bodyId`, which is neuPrint's property name, and it is the one column every node
   addresses *by name* — `out.profile` validates on it, Connectivity, Skeletons, Meshes and
   Synapses all reach their ids through `idColumn(table, 'neuronId')` — so it is the one that has
   to be Coda's vocabulary. Everything else in a neuron table is a passthrough that only a column
   picker ever names. The precedent is `preId`/`postId`, which Coda has always coined: neuPrint
   answers `RETURN n.bodyId, n.type, p.bodyId, p.type, w.weight` and nobody reads those two as
   neuPrint-flavoured.

   The name itself is `ID_COLUMN_NAME` in `core/ids.ts`, beside the grammar and for the same
   reason: the *name* is a cross-layer agreement exactly as the *format* is, and a disagreement is
   silent. It links only the places where that silence bites — `idColumn` and `rowsWithIds`
   default to it, `ID_ONLY_SCHEMA` is made of it, Upload Table renames onto it, and
   `neuprint/schema.ts` keys its property table on it. It is deliberately **not** threaded through
   every `'neuronId'` in the tree: a node's param default is a value somebody may change rather
   than a definition, and a constant honoured at a fifth of its sites implies a discipline nobody
   keeps. (It cannot live in `tableOps.ts`, where it started — `src/data` may not import
   `src/nodes`, so it could not reach the neuPrint seam from there.)

   **Each backend maps into it at its own edge**, which is invariant 8's shape again and the same
   thing Upload Table's `ID column` has always done. For neuPrint that seam is one table,
   `PROPERTY_NAMES` in `neuprint/schema.ts`, read in **both** directions because each fails
   silently on its own: `neuprintProperty` builds the `RETURN` list — and `RETURN n.neuronId` is
   valid Cypher against a property that does not exist, so every id comes back `null` — while
   `CORE_NAMES` carries both spellings, which stops discovery offering `bodyId` as a *newly
   found* property and putting the id in every neuron table twice under two names.
   `NEURON_COLUMNS` derives that `RETURN` list from the canonical schema rather than restating
   it, so it broke the instant the column was renamed; `neuprint.test.ts` asserts the query text,
   which is what caught it.

   **`neuprintProperty` has four call sites and two of them are in the exporters**, which is the
   easy half to miss: `NEURON_COLUMNS` and `labelClause` in `cypher.ts`, plus the `idsFromLabel`
   emitter in each language, because `neuprint_search(field = …)` and `NeuronCriteria(<field>=…)`
   both take a *picked column name* straight to a neuPrint API. Unreachable on neuPrint today —
   that picker offers `str` columns and the id is `i64` — and live the moment a CAVE source
   publishes a `str` id, where R's version matches nothing at all with no error. Those two are
   the first `src/export → src/data` imports in the tree; one table beats a third copy.

   **Raw Cypher is deliberately exempt**: `inferTableFromCypher` names columns after the
   expression the user typed, so `RETURN n.bodyId` really does yield a column called `bodyId`.
   `RETURN n.bodyId AS neuronId` is what makes one meet a Neurons socket, and the node's own
   example does exactly that.

   The cost was taken knowingly: a saved graph loses any column param somebody had explicitly set
   to `bodyId`. It fails loudly rather than silently — `resolveColumn`'s rule 2 keeps the stored
   name and `validateColumnParams` reports `Missing column: bodyId` — and a value still equal to
   a declared default falls back on its own, so `out.scatter`'s `idColumn` self-heals. There is
   no migration shim, on the doctrine that a shim is how a symbol acquires a second spelling.

   **Geometry carries the id too, as plain `id`, and the rename there is the interesting half.**
   `SkeletonGeometry` and `MeshGeometry` held a `number`, which was the rounded copy of the
   attribute table's exact id on any source whose ids do not fit in a double — benign on neuPrint
   and the mock, and an empty selection on CAVE, because `Viewer3D` compares it by string against
   `rowsWithIds` and both morphology exporters key filenames on it. It is still a **draw and
   export key** and not the identity; that stays in the attribute row, which is the only place a
   type, a status and a unit can ride along. It is `id` rather than `neuronId` because a region
   mesh is not a neuron.

   `MeshGeometry.label` is gone, absorbed into that field. A region mesh has no neuron id, so the
   number was `0` for every one of them while `label` carried `ME(R)` — and every consumer
   without exception wrote `label ?? String(bodyId)`. A distinction erased at every use site is
   not one, and it only collapsed once the id had become text.

   The one knock-on worth knowing is `knnTable`, which builds `queryId`/`targetId` from a
   skeleton set. It reads them out of the **attribute table** rather than off the geometry, and
   takes that column's dtype with them, so a `queryId` is the same value _and type_ as the
   `neuronId` that fed it. Deciding a dtype here instead would mean choosing between rounding a
   wide id back into an `i64` and handing every neuPrint user a text column where a number used
   to be — which changes what a bare `527536` means in a Table filter and how the column sorts.
   `inferOutputs` reads the same dtype off the input _type_, which is invariant 3 across a seam
   the source rather than the node decides.

   Both emitters had to learn it too, and each fails silently otherwise: `pyLongIntList` emits
   unquoted Python integers because `NeuronCriteria(bodyId=['1001'])` matches nothing, and the R
   emitter emits a **character** vector because R's default numeric is a double. The golden
   files caught both.

   Both also normalise the id column at their own seam, and `coda_neurons` is now a helper in
   **each** language rather than only in R. On the Python side it goes through
   `codaNeurons(ctx, frame)` in `emitters/common.ts`, which declares the helper *and* emits the
   call, because those are two separate acts at a call site and `resolveHelpers` only writes out
   what was asked for — so a site that emits the call and forgets `ctx.helper` produces a notebook
   referring to a function nothing defines, invisible to the golden file because some other node
   in the fixture happened to request it. `neuron.roiCounts` had already lost the pairing that
   way. The rule: neuprint-python publishes `bodyId` and neuprintr
   publishes `bodyid`, so an unrenamed frame meets the next generated cell — a Filter, a Group
   By, anything carrying a column param — addressing a column it does not have. Note the
   asymmetry that keeps the emitted code readable: the *argument* stays the library's, so a call
   reads `NeuronCriteria(bodyId=df['neuronId'].tolist())`. Coda's column goes in, neuPrint's
   parameter takes it. `bodyId_pre`/`bodyId_post` are untouched for the same reason — they are
   pandas suffixes on `fetch_adjacencies`' own frame — and so is
   `connection_table_to_matrix(conn, 'bodyId')`, which appends `_pre`/`_post` itself.

## Gotchas found the hard way

- **`defaultSize` sizes React Flow's _wrapper_, and only a viewer's card fills one.** The card
  stretches to the wrapper solely under `data-sized`, which `CodaNodeView` sets for resizable
  nodes — i.e. `category: 'visualisation'`. Declare `defaultSize` anywhere else and the wrapper
  is taller than the card. That slack would be invisible except for the state bar:
  `.coda-node::before` is inset against the _wrapper_, because `.coda-node` is deliberately
  unpositioned so the handles and the run ring can escape its `overflow: hidden`. So the bar
  takes the wrapper's height and hangs below the card as a coloured line with nothing beside
  it. A node that only wants to be wider sets `NODE_BODIES[type].width`, which goes through
  `--node-width`. `nodeResize.test.tsx` asserts it across the whole registry, since nothing
  else catches it.

- **Two wires between the same pair of nodes are not a cycle**, and `topoSort` used to say they
  were. It counted indegree over `graph.edges` while decrementing through `neighbourIndex`,
  which _deduplicates_ node pairs — so a target joined twice was incremented by two and
  decremented by one, never reached zero, and came out in `cyclic`. The count is now derived
  from the same index that decrements it, which is what makes them unable to disagree again.

  Recognising it matters more than the arithmetic, because the symptom points nowhere near the
  sort. `wouldCreateCycle` is a separate and correct walk, so the link connects normally; then
  inference drops the target's input types and **every column picker on it empties out**, while
  a result cached from before the second wire stays on screen. It reads as a node that has lost
  its schema. `Paths → Network` (network _and_ layout) is the first wiring that hits it by
  design; Explore's `Hits` and `Selected` arriving at one Join is the other way in.

- **A column picker used to substitute a different column, and it cost 9 GB.** `resolveColumn`
  answered "the first compatible column" whenever the stored one was not in the current schema.
  That reads as helpful and is not: a schema without a column is very often a schema that has
  not _arrived_. neuPrint publishes only the canonical seven neuron properties until
  per-dataset discovery lands, so on a fresh session every discovered property looks deleted.

  Reported live as Firefox holding 6-10 GB on one tab. A Pivot whose `Columns` named `somaSide`
  had it replaced by the first column — which `Rows` had already taken — so it pivoted `type`
  against itself: 15,000² = 225 million cells across five accumulator arrays, inside one
  `evaluate`, then cached. The run stalled ten seconds and the editor never recovered;
  unplugging the Pivot avoided it and Clear Results freed it, which is the signature.

  **A chosen column is now kept.** Rule 2 of `resolveColumn`: the stored name survives a schema
  that does not list it, and reaches `evaluate` to fail there naming the column. A loud failure
  about the column you picked beats a quiet success on one you did not — and it makes the
  singular resolver agree with `resolveColumns`, which has always merely dropped what it could
  not find. A value still equal to the definition's _declared_ default is a suggestion rather
  than a decision and does still fall back, which is what lets `out.scatter` open on `pre`/`post`
  without failing on a table that has neither. `optional` answers _off_ ahead of all of it.

  Note the knock-on in `validateColumnParams`: each branch now states what the resolver is
  actually about to do (`Missing column: x` when it is kept, `is gone — using "y"` only where a
  fallback is really taken), because that is the only thing that keeps the message true.

- **Nothing was warming the schema, so the first Run behaved differently from the second.**
  The chain is: a dataset node on "Latest" reads its id from `peekDatasets()` → the id lets
  `schemasFromType` call `schemasFor(datasetId)` → that kicks off discovery →
  `reportSourceLearned` re-infers. Both peeks answered "I don't know" _without finding out_, so
  the chain never started: no listing meant no dataset id, which meant discovery never ran, and
  every column picker downstream sat on the canonical seven until the first Run fetched a
  listing as a side effect. That is why running twice fixed it and reloading brought it back.

  `peekDatasets()` now starts the listing the first time it cannot answer, and `schemasFor`
  starts discovery for a dataset it has no state for instead of bailing — which is also the
  only thing that ever asked on behalf of a **pinned** version, whose concrete id needs no
  listing at all. Once per instance, not once per peek: inference runs on every graph mutation
  and a failed listing retried from there would be a request per keystroke. Nothing is asked for
  without a token; recovery is the Sources panel's explicit `listDatasets()`.

  This is `schemasFor`'s existing trade — a peek that quietly starts a fetch — applied to the
  link above it. `inferOutputs` may not await (invariant 2), so a synchronous peek is the only
  place a fetch can start on a graph's behalf, and being re-run when it lands is exactly what
  `reportSourceLearned` is for.

- **`pivotTable` refuses on shape before it allocates**, and that is the backstop rather than
  the fix — the two entries above are the fix. `MAX_PIVOT_COLUMNS` / `MAX_PIVOT_CELLS` are
  checked against the label cardinalities, because by the time an array exists the damage is
  done. It also allocates one accumulator per aggregation rather than all five, so `sum` costs
  8 bytes a cell instead of 40. The general form is worth carrying: **a node whose output size
  is the product of two independently-resolved columns needs a ceiling checked before
  allocation**, because neither picker knows what the other did.

- **A multi-column picker used to drop what it could not yet see, and the first Run differed from
  the second.** `resolveColumns` filtered the stored names against the available ones, and an
  input carrying _no schema at all_ produced an empty list — which then went into the provenance
  key and into `ctx.columns`.

  `Pivot → Select` with two of eight wide columns picked emitted **all eight** on the first run
  after a reload, because empty means "everything" to the Select node. The store then re-inferred
  against the schema the pivot had just published, the key changed, the node went stale, and a
  second Run gave the right answer. Same "runs twice, answers differently" signature as the
  dataset-listing bug in invariant 2, and the same root cause: a degraded answer that nothing
  distinguished from a real one.

  The fix is the singular's rule 2 in the form that fits the plural: **a schema this picker cannot
  see is not a schema without these columns in it.** `resolveColumns` now returns the stored list
  untouched when `columnSchemaFor` answers `undefined`, and still drops a column a _known_ schema
  lacks — which is what keeps `validateColumnParams`' "Missing column(s)" true and stops a name
  the table cannot honour reaching `evaluate`. That distinction is the entire reason
  `columnSchemaFor` answers `undefined` separately from an empty schema.

  It is also what makes `Text columns` safe on both import nodes, whose schema is empty before the
  first run by construction.

- **Module init order.** `graphStore.ts` imports `../nodes` for its side effect, because it
  resolves node types the moment it loads the autosaved graph. Without that import,
  ordering in `main.tsx` becomes load-bearing and a bad order silently drops every node.
- **Type regexes are anchored.** `MockSource` wraps user patterns in `^(?:…)$` to match
  Neo4j's `=~` semantics. So `LC.*` matches `LC4` but **not** `LPLC1`. Don't "fix" this —
  the real neuPrint source behaves the same way because Neo4j does.
- **`localStorage` is undefined** under Node 26 + jsdom unless `--localstorage-file` is
  passed. `persistence.ts` try/catches every access, so the app degrades; tests use
  `clearStorage()` from `src/test/jsdomStubs.ts`.
- **React Flow needs measurements.** In jsdom it marks unmeasured nodes
  `visibility: hidden`, so `getByRole` can't see them — component tests pass
  `{ hidden: true }`. `installJsdomStubs()` supplies ResizeObserver (which must actually
  fire, or charts stay 0×0 and silently render nothing), `getBoundingClientRect`,
  `matchMedia`, and a **2D canvas context** — accept-everything, remember-nothing. The last
  is not for assertions: it is what makes `drawScatter` and `NeuronThumbnail`'s raster pass
  actually _run_, so a crash in either fails a test rather than waiting for a browser. WebGL
  stays absent on purpose, since sigma and three both check for it and degrade, and a fake
  that answered would send them down a render path with no GPU behind it. Note the coupling
  it created: stubbing `getContext` turned `NeuronThumbnail`'s previously-skipped effect live,
  which needs `ImageData` — a global jsdom only defines when the optional `canvas` package is
  installed.
- **`erasableSyntaxOnly` is on**, so no TS parameter properties (`constructor(private x)`).

## Chart colours

Do not pick chart colours by eye. The palette in `src/ui/colors.ts` was validated with the
`dataviz` skill's validator; the header comment records what passed and what didn't.

The load-bearing finding: **only three chromatic families clear the all-pairs
colourblind-safety gate on the dark surface**, which is why socket types are distinguished
by colour _plus shape plus a visible label_ rather than by eight hues. Adding a fourth
socket hue from these ramps fails the normal-vision floor. If you change the palette,
re-run the validator; don't reason about ΔE.

`CHART_INK.grid` is for chrome only. It is 1.27:1 against the dark surface and 1.33:1
against the light one — under the 3:1 non-text floor, i.e. invisible by design. Anything
carrying data (network links, and their arrowheads) takes `muted` instead: 4.9:1 dark,
3.5:1 light, and achromatic so it never competes with a categorical encoding.

## Testing layers

| File                                     | Covers                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `core/graph.test.ts`                     | topo sort, cycles (incl. two wires between one pair), serialisation, lenient loading                                             |
| `core/reference.test.ts`                 | reference edges: the round trip sorting, the identity without its own schema, evaluate not waiting, and that a real cycle and two wires between one pair are unchanged |
| `core/scheduler.test.ts`                 | hybrid eval, caching, invalidation, errors, targeted runs                                                                        |
| `nodes/lib/tableOps.test.ts`             | each op, plus schema/value agreement — and the id bridge: a wide id kept exactly, a rounded one skipped, ids ordered by magnitude |
| `data/mock/generate.test.ts`             | determinism, internal consistency, source semantics                                                                              |
| `examples/examples.test.ts`              | all five examples end to end, inference-clean, non-empty, and their notes' markdown parsing                                      |
| `ui/App.smoke.test.tsx`                  | real app mounted and driven: Run, live filtering, link rejection, undo, per-node run                                             |
| `ui/viewers/viewers.test.tsx`            | chart geometry: bar cap, rounded end, 2px gaps, legend rules                                                                     |
| `ui/panels/fuzzy.test.ts`                | match/ranking behaviour, including boundary alignment                                                                            |
| `ui/panels/palette.test.tsx`             | command `disabled` flags vs live state, type-filtered node items, Space flow                                                     |
| `ui/panels/overlay.test.tsx`             | expand/close paths, rail params, and that restyling does not stale a node                                                        |
| `ui/params/paramGroups.test.ts`          | tabs/rows reshaping: that the panel shows every param the flat rail did, exactly once                                            |
| `ui/export.test.ts`                      | CSV quoting/nulls/chunking, wide-matrix CSV, filenames, standalone SVG                                                           |
| `export/python/export.test.ts`           | both fixtures against their goldens, every wired port declared, every emitting type reached, and a neuPrint cell refusing on a CAVE dataset |
| `ui/panels/notebookExport.test.tsx`      | (also) the warning on the Save item: one per format, naming the steps, and silence on a graph that exports whole |
| `ui/panels/palette.test.tsx`             | (also) that the export rows' peek starts no walk, and light up once one has run |
| `ui/format.test.ts`                      | that an id column prints verbatim while the count beside it groups, and that an aggregate of one is a quantity again             |
| `ui/panels/nodeBrowser.test.tsx`         | rows/thumbnails/signatures, chip-search exclusivity, entry points                                                                |
| `ui/encoding.test.ts`                    | palette rules: 8 slots, Other fold, area scaling, null handling                                                                  |
| `ui/viewers/networkLayout.test.ts`       | topology reading, layering (incl. cycles), all four layouts                                                                      |
| `ui/viewers/networkRebuild.test.tsx`     | that restyling never re-runs the layout — the camera-reset regression, counted                                                   |
| `ui/viewers/layoutMemo.test.ts`          | that a settled layout returns only while it still describes the graph                                                            |
| `ui/viewers/networkDraw.test.ts`         | reciprocal curvature, arrow geometry, the exported SVG                                                                           |
| `ui/viewers/networkStyle.test.ts`        | focus/ego sets, dimming (hue kept, theme-flipped), and what a tooltip decides to say                                             |
| `ui/viewers/networkViewer.test.tsx`      | the caption: counts, the label-thinning admission, size refusal                                                                  |
| `data/neuprint/neuprint.test.ts`         | Cypher building/escaping, response decoding, both halves of the `bodyId`→`neuronId` seam, schema discovery, mesh-source resolution, nm conversion |
| `data/precomputed/precomputed.test.ts`   | shard lookup, multi-LOD manifest, Draco decode, legacy fragments, CORS fallback                                                  |
| `nodes/transform/updateRootIds.test.ts`  | the repair: only stale rows looked up, supervoxels sent as raw uint64, a current row left alone even with a warm cache, and a row with no supervoxel untouched |
| `data/cave/rootIds.test.ts`              | the drift check: ids sent as unquoted integers, asked once per chain and re-asked when the wiring changes, a late lander not overwriting a newer answer, only the unseen ones asked, and nothing at all without a chunkedgraph |
| `data/cave/cave.test.ts`                 | CAVE against recorded bodies: a wide root id kept exactly, the string-aware scan, the annotation pivot, an anchored pattern, and every refusal |
| `nodes/lib/datasetFamilies.test.ts`      | (also) that every CAVE family names a datastack spec and every spec a family — the join key nothing else checks |
| `data/cave/live.test.ts`                 | the same source against the real services, skipped without `CAVE_TOKEN` — the only thing that notices an endpoint shape changing, the mesh and synapse clouds proved to share one nanometre frame, Aedes' edge list built by counting with nothing configured, and a loadable scene assembled for all three datastacks |
| `data/annotations/annotations.test.ts`   | annotation sources: the `Token` scheme, the pseudo-workspaces dropped, a wide id kept as text, the outer join and the later source winning — plus the route fallback's three rules |
| `data/annotations/live.test.ts`          | the same against real FlyTable, skipped without `SEATABLE_TOKEN` — including the ids proved to be beyond double precision |
| `nodes/annotation/annotations.test.ts`   | the three source nodes: the two halves of one join asserted against each other, half a chain published as nothing, a Select in the chain (the case that decides the socket type), and a table with no `neuronId` refused twice |
| `nodes/query/morphology.test.ts`         | the shared `Max neurons` ceiling and what its refusal message blames                                                             |
| `ui/nodes/nodeRunRing.test.tsx`          | run-indicator arithmetic: dash fractions, the zero floor, indeterminate mode                                                     |
| `ui/nodes/runRing.placement.test.tsx`    | that the outline renders outside the clipped card (slow mock, so 'running' is observable)                                        |
| `nodes/analysis/network.test.ts`         | BuildNetwork semantics + the selection round-trip                                                                                |
| `nodes/analysis/nblast.test.ts`          | the units conversion above all, plus the flattening, the labels, the ceiling, the voxel refusal, and every control reaching the request |
| `nodes/analysis/nblastKnn.test.ts`       | the k-NN shape: the rectangle laid out long, the padding dropped and counted, and the id columns named so a neuron id is not a quantity |
| `core/values.test.ts`                    | what a node footer says about a geometry value: its units printed always, and voxels-vs-unknown told apart                        |
| `nodes/lib/linkageOps.test.ts`           | the tree ops: the square-but-not-one-population refusal, exactly-k against a tie, clusters numbered in leaf order, the copied buffer |
| `nodes/analysis/linkage.test.ts`         | the three nodes: every control reaching the request, the cut carried on the pass-through, and a restyle costing no run             |
| `ui/viewers/dendrogramLayout.test.ts`    | the brackets: slot centres, a subtree as a contiguous run, a branch coloured only where its leaves agree, and both orientations     |
| `ui/viewers/tooltipPoint.test.ts`        | a tooltip's coordinates: relative to its containing block and divided by the zoom, plus that the stylesheet still says `absolute`   |
| `nodes/lib/labelsToNeurons.test.ts`      | labels to neurons: a type expanding to every neuron carrying it, matched as text, the first row for a repeat, and a collision suffixed |
| `nodes/transform/labelsToNeurons.test.ts`| the two registrations: identical params, one warning that differs, and a neurons type published for a 3D socket                     |
| `ui/nodes/labelsToNeuronsBody.test.tsx`  | the readout: what a wrong `Match on` says, not-wired against not-run, and every non-advanced param drawn                            |
| `ui/viewers/dendrogram.test.tsx`         | the card through `ValuePreview`: a click handing back exactly the leaves under it, and every admission the caption makes           |
| `data/neuroglancer/scene.test.ts`        | scene editing against the real published shapes, and the URL round-trip                                                          |
| `nodes/output/neuroglancer.test.ts`      | what lands in the link: segments, colour agreement with the 3D view, the limit                                                   |
| `ui/viewers/neuroglancerViewer.test.tsx` | that a restyle navigates the frame rather than remounting it                                                                     |
| `ui/nodes/nodeResize.test.tsx`           | handles outside the clipping card, resize not invalidating a result, gesture undo                                                |
| `ui/nodes/paramFold.test.tsx`            | folding a card's param rows: the header button surviving the band, notes excepted, one undo step, and that it costs no run       |
| `ui/nodes/collapsedPorts.test.tsx`       | collapse to a header: handles moved not removed, each still addressable, and the wrapper's width kept but not its height         |
| `ui/nodes/hiddenParams.test.tsx`         | the `… N more` hint: both counts, the card with no band at all, what is not a change, and that it never closes an open inspector |
| `nodes/lib/neuronSearch.test.ts`         | the Explore query language: parsing, matching, null rules, the fuzzy fallback, ranking, completion                               |
| `data/cache.test.ts`                     | IndexedDB-less degradation, fingerprint/expiry invalidation, index dedupe                                                        |
| `ui/explore/thumbnail.test.ts`           | silhouette projection/shading, and the data-driven row spec                                                                      |
| `ui/explore/chips.test.ts`               | that the chip hues in `theme.css` still match `colors.ts`, and that a slot follows the field                                     |
| `ui/explore/explore.test.tsx`            | the widget: live filtering vs debounced commit, paging staleness, selection, completion, and it mounted in the real editor       |
| `nodes/query/explore.test.ts`            | the node's ports: that `All` ignores both the search and `Max hits`, and infers what it evaluates                                |
| `nodes/lib/labelLookup.test.ts`          | label parsing, the typed/wired union, and what the unmatched report refuses to claim                                             |
| `nodes/query/idsFromLabel.test.ts`       | exact vs regex, the anchoring, the union reaching one query, and empty meaning empty                                             |
| `ui/nodes/idsFromLabelBody.test.tsx`     | the card: every non-advanced param rendered, and the unmatched line naming the labels                                            |
| `nodes/lib/datasetFamilies.test.ts`      | version ordering, latest-vs-pinned resolution, and the deployment/base-URL mapping                                               |
| `nodes/dataset/dataset.test.ts`          | per-dataset nodes infer what they evaluate, the custom node's lazy source, that the superseded node still runs, and the drift advisory following the annotation chain in both directions |
| `ui/nodes/datasetBody.test.tsx`          | preview above fields, the version dropdown, the resolved id, and no expand button                                                |
| `data/mock/morphology.test.ts`           | tree validity, determinism, tube meshes, synapse placement                                                                       |
| `store/inference.test.ts`                | inference against a source that has not learned its listing yet, and the re-infer signal                                         |
| `ui/panels/startPage.test.tsx`           | start page: both rails, a tile per card, the replace-confirm, close-vs-dismiss, and both ways back                               |
| `nodes/lib/profileStats.test.ts`         | the profile roll-ups: distinct partners, nested-ROI filtering, the last-parenthesis side rule, NT column matching                |
| `nodes/lib/networkOps.test.ts`           | filter order, ranking after the weight cut, and the recomputed degree roll-ups                                                   |
| `nodes/output/profile.test.ts`           | that Profile is a tap, and that paging is free while pinning is not                                                              |
| `ui/viewers/profileViewer.test.tsx`      | the widget: pager clamping, absent tiles vs dashes, the threshold reaching a heading, card-vs-overlay, and the annotation chain reaching both fetches and the cache key |
| `ui/markdown.test.ts`                    | the markdown subset against the real published blurbs, plus what a hostile one cannot do                                         |
| `store/companion.test.ts`                | that a dataset node brings its Description card, as one undo step, and which families opt out                                    |
| `store/autowire.test.ts`                 | that a new node's Dataset socket arrives fed, and every case where it must not — ambiguity, load, an existing wire               |
| `store/fitOnLoad.test.ts`                | that opening a graph asks for a fit, and that an empty one does not leave the request pending                                    |
| `ui/nodes/descriptionBody.test.tsx`      | the card in the real editor: links, nesting, the overlay, and that raw HTML never mounts                                         |
| `store/library.test.ts`                  | the browser shelf against real IndexedDB: name-as-identity, and that a save with nowhere to go _rejects_                         |
| `ui/panels/library.test.tsx`             | the menus and the start-page rail: the replace prompt, the delete prompt, an opened entry landing on the canvas                  |
| `ui/panels/sources.test.tsx`             | the sources dialog: a tab per source, the tab an auth failure lands on, and where the credential promise sits                    |
| `nodes/annotation/note.test.ts`          | that a text note is never executed, deferred, stalled or counted, and round-trips                                                |
| `store/links.test.ts`                    | breaking and re-routing links: one undo step, the id kept, and what a refused rewire leaves                                      |
| `core/splice.test.ts`                    | dropping a node on a wire: the downstream check needing the upstream link applied, isolation, and one link left on the port |
| `store/splice.test.ts`                   | that the move and the rewire undo as one gesture, and that a node which does not fit is still moved                          |
| `ui/panels/edgeMenu.test.tsx`            | the link menu: that its header names the wire it is about, and that deleting leaves the nodes                                    |
| `ui/panels/nodeMenu.test.tsx`            | the node menu's two caches: Results rather than "cache", and Clear Cache gated on the node declaring one                        |
| `ui/viewers/tableSummary.test.tsx`       | the inspector's text readout: every column listed, an id kept whole, a long value cut but recoverable, and no dash for no rows |
| `ui/nodes/cacheAge.test.tsx`             | `cached 3d ago ⟳`: the age surviving a restored result, the click reaching both caches, and no threshold hiding a fresh one     |
| `ui/nodes/noteCard.test.tsx`             | the note card: markdown as prose, no node chrome, Escape abandoning an edit, the frame toggle                                    |
| `nodes/lib/connectivityOps.test.ts`      | the traversal: the pre→post swap, the both-ends dedupe, no re-expansion, minWeight pruning                                       |
| `nodes/query/connectivity.test.ts`       | the node: that it advertises the columns it builds, and that Hops reaches the source                                             |
| `layout/layout.test.ts`                  | the ELK mapping and placement, the port convention and option keys against real ELK, and a network laid out by it                |
| `layout/routing.test.ts`                 | edge routes: a wire bent past a card, pinned sockets honoured, a partial measurement declined, and what stales a route           |
| `ui/edgeRoute.test.ts`                   | the wire's geometry: the fillet clamped to its own segment, and the ends staying on the sockets rather than on ELK's guess       |
| `ui/edgeRouting.test.tsx`                | both routings drawn, the hit path following the detour, and which wires are marked as having followed a route                    |
| `nodes/lib/pathOps.test.ts`              | the bidirectional search, the feed-forward prune, bottleneck ranking, and what truncation admits                                 |
| `nodes/query/paths.test.ts`              | the node end to end, and that the collapse reaches the _source_ rather than relabelling after                                    |
| `ui/panels/layoutControls.test.tsx`      | the four rail buttons, the bubble, what clears the auto-layout toggle, and routes dropping on a drag but not a param edit        |
| `ui/viewers/scatterPlot.test.ts`         | the scales and the log drop, the point budget's stride, the trend in transformed space, and a lasso catching rows nothing drew   |
| `ui/viewers/scatterDraw.test.ts`         | marker geometry, the colour+shape batching, and the exported SVG                                                                 |
| `ui/viewers/scatterViewer.test.tsx`      | the scatter caption: every admission it makes, and which legend keys stand down in a card                                        |
| `ui/viewers/heatmapPlot.test.ts`         | the heatmap fold: a grid bounded by the plot, the strongest cell of a block surviving, the ramp table proved lossless, thinning |
| `ui/viewers/svgBuilders.test.ts`         | every synthesised export through the real serializer: one namespace declaration, one font, and a document that actually parses |
| `nodes/output/scatter.test.ts`           | the tap, id-vs-row-index selection, and that `Max points` stales nothing                                                         |
| `core/columnParams.test.ts`              | what a column picker may complain about: unknown-vs-empty schema, what `optional` changes, and a plural keeping an unseen list   |
| `nodes/output/barChart.test.ts`          | the tap, that an unpicked column is a warning and not a refusal, and the stack-by-itself catch                                   |
| `nodes/table/pivot.test.ts`              | the two outputs describing one pivot, and the wide schema arriving only by observation                                           |
| `nodes/lib/tableFilter.test.ts`          | a header cell's grammar: a bare value following the column's dtype, the null rule, and every clause it drops rather than applies |
| `nodes/output/table.test.ts`             | the two ports: the tap kept whole, filtering staling the node while paging does not, and a bad clause refusing nothing           |
| `nodes/table/sample.test.ts`             | the four sampling modes, a draw reproduced from its seed, and the seed costing nothing in the other three                        |
| `nodes/table/dedupe.test.ts`             | the three `keep` modes, an empty picker comparing whole rows, row order kept, and a null told apart from the text "null"       |
| `data/csv.test.ts`                       | reading somebody else's file: quoting, delimiter-by-consistency, header bias, and every value the parse refuses to widen         |
| `data/uploads.test.ts`                   | the store against real IndexedDB: content addressing incl. a separator collision, a write that rejects, and the peek's one read  |
| `nodes/table/upload.test.ts`             | the node: the schema arriving by peek, the neuronId rename, what a graph opened elsewhere says, and the filename costing nothing   |
| `ui/nodes/uploadBody.test.tsx`           | the card's four states — and that 'looking' is never printed as 'not here' — plus the size ceiling refusing before it reads      |
| `nodes/table/fromUrl.test.ts`            | the fetch: deferred by the auto pass, Refresh as the only re-fetch, the schema keyed by URL, and what each refusal blames        |
| `nodes/lib/idList.test.ts`               | reading pasted ids: every separator, a bad token refusing the list, an eighteen-digit id kept exactly, and the 19-digit ceiling  |
| `nodes/query/inputIds.test.ts`           | the node: no dataset means no query, the seam asked in numbers, no status filter, empty never all                                |
| `ui/nodes/inputIdsBody.test.tsx`         | the card: the counts, the ids named as missing, and that it claims nothing with no Dataset wired                                 |
| `nodes/table/stack.test.ts`              | the union schema needing both sides, a real dtype clash refused at run time, and the source column                               |
| `ui/fullscreen.test.tsx`                 | the ⛶ and `F`: what element is handed over, that a refusal leaves the button unpressed, and the manifest's relative scope        |
| `ui/exportValue.test.ts`                 | SWC's 1-based ids and -1 roots, OBJ's 1-based faces, the JSON typed-array unpack, the file cap, and GraphML parsed as real XML   |
| `ui/nodes/resultDownload.test.tsx`       | the card foot's ⤓: absent before a run, withheld on a viewer card, the formats offered, and the dataset card the one rule reaches |
| `nodes/output/download.test.ts`          | the tap: identity pass-through, deferred by the auto pass, and settings re-running nothing                                       |
| `ui/useDownloads.test.tsx`               | the side effect: written on an executing run, not on an unchanged one, and the auto-run warning                                  |
| `ui/panels/startPage.test.tsx`           | (also) the field-guide links, in the welcome bar and the Help menu, composed against `BASE_URL`                                  |
| `nodes/lib/datasetStats.test.ts`         | the dataset roll-ups: null-vs-empty as one absence, absence counted apart, the residual fold, and one walk serving every cap        |
| `nodes/query/roiSummary.test.ts`         | the two ROI nodes: answering from a Dataset alone, a region kept when its summability is unknown, and the asymmetry between them   |
| `nodes/output/datasetSummary.test.ts`    | that a chart setting stales nothing while `Status` does, and that it emits no ports at all                                        |
| `ui/viewers/datasetSummary.test.tsx`     | the card: absent tiles vs dashed ones, why an empty one is empty, the caption naming its population, ring-vs-bars, and paging |
| `ui/useNeuronIndex.test.tsx`             | one load across two widgets, a late mount with no spinner flash, and a reload reaching every subscriber                            |
| `ui/raster.test.ts`                      | triangles to masks and masks to outlines: clipping, brightest-wins, a concavity kept, split blobs, and the closed-ring simplify |
| `ui/viewers/roiProjection.test.ts`       | the three anatomical planes, an outline that keeps its notch, the explode proved non-uniform, the frame held at full, and mesh volume |
| `data/obj.test.ts`                       | reading somebody else's OBJ: every face-index form agreeing, polygons fanned, CRLF, and what a 200 that is not a mesh says |
| `nodes/output/rois.test.ts`              | the ROIs node: no ports at all, every control costing no run, and what it says with a source publishing no region meshes |
| `data/meshDecimate.test.ts`              | vertex clustering: the silhouette surviving, no degenerate faces, determinism, and welding a seam counted apart from decimating |
| `ui/viewers/roiOutlines.test.ts`         | what survives when the meshes are released: three planes per region, the size claim, and a fingerprint that re-fetches on a changed region list |
| `ui/viewers/rois.test.tsx`               | the card through `ValuePreview`: that it asks before spending 60 MB, stops asking once cached, drops the rail when compact, and marks the volume an estimate |
| `ui/viewers/roiStyle.test.ts`            | the region hue: a left/right pair sharing one, sub-regions distinct, literal hex, and a published ratio clamped |
| `data/neuprint/roiHierarchy.test.ts`     | the level above primary: groups from the real hemibrain tree, the root excluded, sub-primary not descended into, and a malformed tree losing the grouping not the map |
| `nodes/transform/selectOne.test.ts`      | stepping free vs committing stale, an index past the end emitting nothing, and one skeleton re-measuring its bounds                |
| `ui/nodes/selectOneBody.test.tsx`        | the pager card: not-run vs not-wired, the Live label counted once, and the gap between what is shown and what is emitted           |
| `nodeguide/nodeGuide.test.ts`            | the node guide's data: a paragraph per node, socket styles, internal-vs-advanced params, an enum's label, and the examples cross-reference |

## Exporting a notebook

`Save ▸ Export as Jupyter Notebook`, or the palette's `Graph ▸ Export as Jupyter Notebook`, writes the graph as
a `.ipynb` built on **neuprint-python, pandas and navis** and nothing else. `src/export/python/` is the whole of it; nothing in `src/core`,
`src/data` or `src/nodes` knows it exists, because the exporter reads the graph and the graph
never reads back.

**The contract is a faithful starting point, not a bit-identical reproduction.** It runs, and
for the common path it answers what the canvas answered — but it is meant to be read and
edited, so where Coda and neuprint-python genuinely differ the cell says so in a `NOTE` rather
than contorting itself. That choice is what keeps the tier-3 nodes (Connectivity's traversal,
Explore's search) at one generated helper each instead of a Python port of `src/nodes/lib`.

**The exporter is loaded on demand.** `downloadNotebook` does `await import('./python/exporter')`,
because every emitter and every generated Python helper is inert string-building that only runs
when somebody asks for a notebook — statically importing it put **54 kB (17.6 kB gzipped)** into
the main chunk, paid on first paint by everyone. Same doctrine as elkjs, three.js and sigma;
verify with `pnpm build` that `exporter-*.js` stays its own file.

**`src/export/canExport.ts` is the light half, and it exists for that reason.** Whether a graph
can be exported is asked by two surfaces, one of them (`buildCommandItems`) on **every store
change** — so answering it must not reach the exporter. It is also the single statement of the
refusal policy: `reason`, `detail` for the menu's paragraph and `fix` for the palette's one
breadcrumb segment. Two lengths, one rule; the surfaces differ in room, not in what they consider
unexportable.

**Emitters live in their own registry, keyed by node type** (`registry.ts`), not on the
`NodeDefinition`. Two reasons: a viewer's emitter can reach `src/ui`'s palette, and a node type
with no emitter degrades to a TODO cell rather than failing to compile. The cost is real and is
the thing to watch — an emitter can quietly stop agreeing with the `evaluate` it mirrors, and
nothing type-checks the pair. `coverage.test.ts` is the tripwire: every registered type either
has an emitter or is named in `NO_EMITTER` with a reason.

### The softer half: warning that an export will have gaps in it

A refusal says the export is not worth making. Beside it, both surfaces now say how much of a
graph the walk **could not translate** — `⚠ 2 steps will be left as TODO` on a palette row, and
a sentence naming them under the Save menu's item. The row still works: an export with gaps in it
is worth having, which is why this sits *on* the item rather than replacing it the way a refusal
does.

**The only honest way to answer is to run the exporter**, and that is the decision the design
turns on. The obvious alternative is a static table of which node types emit in which language:
instant, main-chunk, and a mirror of two registries that nothing type-checks against them — the
`NO_EMITTER` shape, which works only because `coverage.test.ts` pins it. Worse, it could not see
most of what actually becomes a TODO. A cell comes out as one for five different reasons, and
only the first is a fact about the *type*:

1. no emitter for this language,
2. a backend the emitter was not written against (`emitterBackends`),
3. a required port nobody wired,
4. an upstream that was itself a TODO,
5. the emitter refusing on its own params — `Paths` with `Collapse types` on, a dataset that
   could not be resolved, a column nobody picked.

Running the real walk sees all five by construction and cannot drift. So both walks report
`todos: TodoStep[]` — recorded where `emittedTodo` already is, plus the unknown-node-type branch,
which `continue`s before that check and is the worst case there is, since it binds nothing and
blocks everything downstream. Reported as `{nodeId, label}` rather than recovered from the
finished document by scanning for `# TODO:`, which would be matching on prose.

**`src/ui/exportWarnings.ts` is the `peek*` contract again**, with one deliberate split:

- **`peekExportWarnings` starts nothing.** It is a cache read. `buildCommandItems` calls it on
  every store change while the palette is open, and a peek that kicked off a walk there would run
  one per change. Same rule, and the same reason, as `peekBases`.
- **`requestExportWarnings` is the half that works**, called when a surface opens — the Save
  menu's own mount, and an effect on the palette's `menu` state. It loads the exporters lazily,
  so `canExport.ts` being separate is preserved exactly: nothing here is reachable until somebody
  opens one of those two.

The answer is keyed on the graph **object**, which the store mints afresh on every commit, so a
stale answer is structurally impossible — a changed graph is a cache miss. A newer graph arriving
while a walk is in flight owns the cache when it lands, which is the same ownership check the
root-drift advisory needs and for the same reason.

**The message does not say *why* each step is a TODO.** The five reasons above are genuinely
different and every one of them is already stated in the document itself, beside the step it is
about. What a reader wants before clicking is how much of the graph will be missing, and which
parts.

**+1,890 bytes on the main chunk**, measured — the module, both surfaces and the CSS. `main` still
matches neither exporter; both stay behind `await import`.

**Verified in a real browser** over CDP, because this is colour and wrapping: both surfaces, both
themes, no console errors. `--status-warn` resolves to `#fab219` on the dark panel (9.78:1) and
`#8a5e00` on the light one (5.41:1) — the token's own measured values, and the reason it is
per-mode at all, since the bright gold is 1.74:1 on light. The Save panel is **315px wide with no
warning and 313px with one**: the sentence wraps inside the width the descriptions already set, so
the menu does not jump between the two states. That was the thing worth pointing a browser at.

**The two surfaces refuse differently, and that is not an inconsistency.** A menu has room to
answer back, so the Save menu lets the click through and replaces the item with a sentence
naming what to change. The palette closes on pick, so there is nowhere to put that sentence
afterwards — the row is `disabled` and the _hint_ carries it, which is the idiom every other
command there already follows. Getting this backwards would put a lit row in the palette that
closes it and does nothing, and on a bundled example that is the usual state rather than an
edge case.

**Two things are refused; everything else is a TODO.** Every other gap emits a TODO,
because the surrounding cells are still worth having. A `dataset.mock.*` connectome is generated
in the browser: no server, no token, no id that means anything outside the tab — so the _first_
cell is the one with nothing behind it, and what would come out is a notebook nobody can fix
without knowing which real dataset was meant. Note the consequence: **all five bundled examples
are refused**, which is why the golden files are built on `fixture.ts` rather than on them.

**The second is a dataset from a backend *this format* has no emitter for**, which today means
CAVE in R and nothing in Python. The same reasoning arriving from the other direction: the dataset
cell is the one with nothing behind it, and the walk cascades a TODO to every node downstream, so
what comes out is a document of nothing but TODOs. `DatasetFamily.notebook` is the single
statement of which families each exporter can be built for, read by `canExportNotebook` and by
both dataset emitter loops — it had to be, because those two used to disagree: the loops keyed on
the *source id* while the refusal tested `synthetic` alone, so a FlyWire graph passed the check
and produced exactly that document. It is deliberately not derived from `sourceId`, since what
decides it is whether an emitter exists, not where the data comes from — and it is keyed **per
language**, since the day that distinction stopped being academic has arrived.

**A third kind of TODO came with it, and it is not a refusal.** A node whose *own* cell has only
been written for neuPrint, on a graph whose dataset is CAVE, emits a TODO naming the backend —
declared once per emitter through `registerEmitter`'s `backends` rather than guarded in each of
the seventeen that take a Dataset. See *The CAVE half of the notebook exporter* below.

**The walk decides whether an input arrived; emitters never ask.** `ctx.wired(port)` returns a
plain `string` because the walk refuses to call an emitter whose _required_ ports are unwired or
blocked — and `ctx.input(port)` returns `string | undefined` for the ports declared
`required: false`, where absence is a real case. That split removed ~25 hand-written
`if (!ctx.input('in')) return ctx.todo('Nothing is wired…')` guards, each of which hardcoded a
port id as a string. It is the same bug `ports.test.ts` exists for: the walk reads the ids off
`def.inputs` and cannot mistype one, where an emitter did, for months. The two failures are also
reported apart — _unwired_ is a graph somebody has not finished, _blocked_ is a node this
translation could not emit, and conflating them sends the reader to fix a wire that is already
there.

**A TODO binds nothing.** `ctx.todo()` is the single channel for "no code came out of this", and
the walk reads it to decide whether to bind the node's output variables. Without that, a node
that could not be translated still bound its names and everything downstream emitted working
code referring to variables nothing ever assigned. Blocking then cascades with the upstream
node _named_, which mirrors the scheduler reaching `blocked` down exactly the same edge —
"nothing is wired to this" would send somebody to the canvas to fix a wire that is already there.

**One `Client` per dataset node, and every fetch names it.** neuprint-python has a global default
client and every call would find it, which reads more tidily and is wrong the moment a graph
carries two datasets: the second `Client(...)` silently becomes the default and every earlier
query starts answering from the other connectome.

### What was verified rather than assumed

Three findings, each of which was a wrong answer before it was checked:

- **`df.sample(random_state=n)` is the wrong sampler.** It is a Mersenne Twister; Coda's Sample
  node is mulberry32. Same seed, entirely different rows — a notebook that silently disagreed
  with the canvas while looking perfectly reasonable. `coda_sample_rows` is the generator
  transcribed into 32-bit masks, and it was checked against the TS stream across five seeds
  before being believed.
- **`coda_search` was cross-checked against `runSearch`** over 23 queries covering the rules
  that are easy to lose: a missing value satisfying `!=` and nothing else, unanchored regex,
  negation, `1200` matching a neuron id but not a synapse count. Zero divergence. It is
  deliberately **matching only** — no relevance ranking and no fuzzy fallback — and the
  docstring says so, because both change which rows come back where a result is capped.
- **`import navis` does not expose `navis.interfaces.neuprint`.** The package root does not
  import `interfaces`, so the obvious spelling is valid syntax, a well-bound name, and an
  `AttributeError` at runtime. Hence `import navis.interfaces.neuprint as neu`.

Every signature the emitters produce was read off **neuprint-python 0.6.3** and **navis 2.0**
by introspection, not recalled. Two that surprise: `fetch_neurons` returns a _pair_ (neurons,
roi_counts), and there is no `fetch_mesh_neuron` in neuprint at all — meshes are navis's, which
is also where the `lod` argument the `Detail` param maps onto lives.

### Testing, and the half golden files cannot do

`export.test.ts` writes `__fixtures__/everything.ipynb` from `fixture.ts` — one graph wiring up
every emitting type — and compares. Regenerate with `pnpm export:golden` and **read the diff**;
that is the whole point of the format.

**An emitter addresses its ports by string, and that is the registry's real cost.** `ports.test.ts`
runs every emitter against a context that records what it asks for and answers everything, then
checks the ids against the definition. It was written after `out.profile` was found reading an
input called `in` on a node whose port is `neurons` — so it reported "nothing is wired to this
Profile" for a node plainly wired on the canvas, and had done since it was written. It found four
more the same day: `out.scatter` _wrote_ `scatter_plot_table` while the walk bound
`scatter_plot_out`, so anything downstream referenced a variable nothing assigns; `out.neuroglancer`
bound a DataFrame to a port the graph types as a URL; and `out.viewer3d` was written as a
pass-through when it has three optional geometry sockets and emits only the selection. None of
these fail a type check, none produce invalid Python, and the golden file recorded every one of
them as correct.

**The fixture is checked too, and that is why they hid.** `everythingGraph` had wired the 3D
viewer to a socket it has never had — `addEdge` takes the handle it is given — so the export
said "nothing is wired", and the golden agreed. A fixture whose coverage is a claim rather than a
fact is worse than no fixture, because it is what everything else is checked against. So
`export.test.ts` now asserts that every fixture edge lands on a declared port _and_ that the
fixture reaches every emitting type. The second is what forced all six dataset families in
rather than `hemibrain` alone: they share one generated emitter, but `mushroombody` carries no
version in its dataset id and `neuron.dataset` reads its id from a param, and neither branch is
reachable through `hemibrain`.

**A snapshot cannot tell whether the Python is valid**, which is exactly how the navis bug got
in. `scripts/check-export.py` is the other half, in three passes: syntax, undefined names, and
attribute resolution against the _real_ installed libraries. The third is the one that earns the
script and the only one that can catch an import that does not expose what it looks like it
exposes; it is skipped with a notice where the libraries are absent, and `--strict` turns that
skip into a failure so a check that did not run cannot report success. Nothing is ever executed —
that would need a token and a network.

It runs in its own workflow (`.github/workflows/export.yml`) rather than in `deploy.yml`,
path-filtered to `src/export/**`: `pip install navis` is minutes against a deploy pipeline that
is otherwise well under one, and it is only ever worth paying when the exporter changes.

### The CAVE half of the notebook exporter

`src/export/python/emitters/cave.ts` and `caveHelpers.ts`. A FlyWire graph now exports as a
Jupyter notebook built on **caveclient, sea-serpent and pandas**, where before it was refused
outright.

**Every signature was read off caveclient 8.2.1 by introspection**, and three are not what an
experienced user would guess:

- **`CAVEclient(datastack, version=N)` pins the materialization for every later query** *and*
  sets `client.timestamp` to that materialization's instant. That is what makes the dataset cell
  the only place a version appears, and it is what `Update root IDs` asks its chunkedgraph
  questions *at*.
- **`client.materialize.version` reads back off the frameworkclient** rather than holding its own
  (`if self.fc is not None and self.fc.version is not None: return self.fc.version`). Checked in
  the source, because the alternative — a `materialization_version=` on every call — is a lot of
  argument for something that would silently query "latest" if the inheritance did not hold.
- **There is no token argument.** caveclient reads `~/.cloudvolume/secrets/cave-secret.json`,
  written once by `client.auth.setup_token()`, where neuprint-python takes one per client.

#### The refusal is per language now, and the policy is still one

`DatasetFamily.notebook` was `'neuprint' | undefined` and is now
`{ python?: …; r?: … }`; `canExportNotebook(graph, language)` takes which format is being asked
about. Forced rather than chosen: R's route into FlyWire is `fafbseg`, which wraps FlyWire
specifically rather than CAVE generally and has no emitter here — so one flag for both formats
would either refuse an export Python can produce or offer an R document of nothing but TODOs. The
palette asks twice and the two rows disagree, which is the honest state.

`src/export/fixture.ts` gained a **second graph** for the same reason: a CAVE node in
`everythingGraph` would make R refuse the whole thing and leave its golden with nothing in it.
`caveGraph` is exported as its own notebook and asserted to be *refused* on the R side.

#### A backend an emitter was not written against is a third kind of TODO

Seventeen Python emitters take a Dataset, and all of them are neuprint-python. Left alone, a
FlyWire graph would emit `fetch_neurons(..., client=<a CAVEclient>)` — valid Python, plausible
reading, an `AttributeError` at best and a wrong answer at worst.

So `registerEmitter` takes `{ backends }`, **defaulting to `['neuprint']`**, and the walk turns an
undeclared backend into a TODO naming it. Declared at the registration rather than guarded inside
each emitter, which is the call `emit.ts` already makes about unwired ports: seventeen
hand-written guards is seventeen chances to forget one, with nothing failing when somebody does.
The default is the narrow one deliberately — a new emitter that says nothing refuses a backend it
was never tested against.

The backend is read off `def.inputs` (any port whose declared type is `dataset`) rather than by
asking for a port called `dataset`, which is the bug class `ports.test.ts` exists for. An
*unresolved* dataset type refuses nothing: no `sourceId` is invariant 2's ordinary state on a cold
session.

#### A reference port yields no variable, and sometimes cannot

`referencesFirst` hoisted every referenced node to the front so a cell naming one would find it
bound. That is wrong for the wiring references exist for: in `CAVE table → Update root IDs →
Dataset` the dataset **consumes** both nodes referencing it, so hoisting it above them classified
it `blocked` by its own annotations and cascaded a false TODO to everything downstream — the very
failure the hoist was added to prevent, arrived at from the other side.

Two changes, and they are a pair:

- **Only a node with no dataflow inputs is lifted.** That is not a precaution, it is the condition
  that makes a reference sound in the first place — the referenced node's identity comes from its
  params alone — made checkable.
- **The walk does not treat an unbound reference port as blocking.** A reference is not a value
  dependency, so an emitter reading one falls back to the referenced node's *type*, which is all a
  reference ever promised.

`clientFor` in `cave.ts` is that fallback, in one place so the two readers cannot drift: the
bound variable's `.client` where the walk bound one, and a fresh `CAVEclient` built from the
reference's type where it did not. The golden covers both branches.

#### What a Coda Dataset is on CAVE, and why it is not a bare client

The neuPrint dataset cell binds a `Client`. This one binds a generated `CodaCaveDataset`, because
a CAVE dataset value is a client **and** a neuron table: the datastack's labels live in an
annotation table, and anything wired to the Annotations socket *replaces* them. One Python name
has to carry both.

**`labels` is fetched on first use, not at construction**, which is the point of the class rather
than a tuple. A graph that only cleans an annotation table never asks for the index, and on
FlyWire that is 139,255 rows over six queries.

#### The helpers, and the one that ran before it was believed

`coda_cave_neurons`, `coda_cave_table`, `coda_seatable`, `coda_join_annotations`,
`coda_update_root_ids`, `coda_int64` — each mirroring a specific piece of `src/data/cave` or
`src/data/annotations`. Two
rules came across that produce a plausible wrong table rather than an error, and both are
transcribed rather than reinvented: the annotation table is read **one kind at a time** (the whole
of `hierarchical_neuron_annotations` is over CAVE's 500,000-row cap, which the server applies by
*truncating*), and a chained source **wins a collision falling back to the earlier one where it
has no value** — a coalesce rather than a replace.

**`merge_reference=False` is passed explicitly and the join is written out.** caveclient will
merge a reference table with its target for you and that is very likely the tidier call; it was
not verified against a live datastack, and a silently different frame is exactly what this
exporter refuses to guess at.

**`pd.to_numeric` is the wrong function for an id column, and it fails silently.** On a clean
column of decimal strings it answers `int64` and is exact — and one null anywhere, which a
supervoxel column has by design, forces `float64`: `720575940628857210` comes back as
`720575940628857344`, a **different neuron**, with every later comparison wrong about a value
nothing flagged. `coda_int64` parses per value with Python's `int`, exact at any width.

That was found by **running** the helpers, on the first try, and it is why
`scripts/probe-cave-helpers.py` (`pnpm probe:cave`) exists. It reads the generated helper cell out
of the golden notebook and exercises it against a stub client — `probe-nblast.mjs`'s idiom one
language over, and for its reason: the golden says the text is unchanged and `check-export.py`
says it parses and its module attributes resolve, but **nothing else executes a line of it**, and
every one of these helpers is pandas. It runs in `export.yml` and is the only step there that
executes generated code. Reading the code did not catch the bug; running it did.

#### What it costs, and what is not covered

**+281 bytes on the main chunk**, measured against a build of the same tree with the feature
stashed out — the family table's one field and the refusal's stack names. Everything else is in
`exporter-*.js`, which stays lazily loaded; `CodaCaveDataset` appears nowhere in `main`.

Not written yet, and each declines with a TODO naming the backend rather than emitting neuPrint
code: **Find Neurons, Explore, Connectivity, Adjacency, Skeletons, Meshes, Synapses, Profile,
Neuroglancer**. `CodaCaveDataset.labels` is what the first two would read, and it exists and is
tested ahead of them for that reason. The table ops downstream are backend-agnostic and already
work.

#### SeaTable, through sea-serpent

`annotation.flyTable` and `annotation.seaTable` emit too, on
[`sea-serpent`](https://github.com/schlegelp/sea-serpent) — one registration each over one
emitter, exactly as the nodes are two registrations over one implementation. Everything below was
established **live against FlyTable**, not read off a README.

- **`Table(name, base=…)` resolves the base itself** by enumerating the account's workspaces
  (`find_base`), so Coda's `Workspace` param has no argument to map onto — it exists because the
  REST API addresses a base by workspace *and* name, which is bookkeeping sea-serpent does for
  you. Where one is set on the canvas the cell says so rather than dropping it silently.
- **`to_frame()` rather than `query()`, and the reason is dtypes.** sea-serpent sanitises on the
  way out: a text column stays text — so an eighteen-digit root id arrives exact under pandas'
  `string` dtype, which is the whole of invariant 8 at this seam — a date column becomes
  datetimes and a checkbox becomes booleans, which is `dtypeFor`'s mapping and better. `query()`
  hands back raw records and loses all of it.
- **The `query` narrowing is offered as a comment where `Columns` is set.** Measured live:
  `to_frame()` is **3.3 s** for all 52 columns of `main.info` (58,340 rows, ~134 MB in memory)
  against **0.8 s** for three through `query(..., no_limit=True)`. Worth having and not worth
  defaulting to — and note this is the one place the notebook is simply *unblocked* where the
  canvas is not, since `/dtable-db/api/v1/query/` sends no CORS headers at all.
- **`query` auto-appends `FROM {TABLENAME}`**, so anything following the column list — a `LIMIT`,
  a `WHERE` — needs the `FROM` written explicitly or the server answers `parse error: unexpected
  LIMIT`. Backticked names are accepted, which is what makes a generated column list safe.
- **sea-serpent names its columns with numpy `str_`.** They index fine and read oddly anywhere the
  column list is printed, so `coda_seatable` normalises them.

**The generated FlyTable cell was run verbatim against the real base**, helpers and all, and
reproduces what the canvas reports: 58,340 rows, **56,309 distinct ids** — the same duplicate
count recorded above — every id text, exact at eighteen digits, and all 58,340 beyond double
precision.

**The credential is `SEATABLE_TOKEN`**, which sea-serpent reads from the environment itself and
the cell passes explicitly anyway, so what it needs is visible. Two deployments are two unrelated
accounts, so a graph reading both wants two tokens and one env var cannot serve them; each cell
names its `server=`.

#### What has not been run

**Nothing has been run against a live CAVE datastack.** `CAVE_TOKEN` is absent here, so for that
half what is verified is the signatures (against the installed caveclient 8.2.1), the syntax and
name resolution (`check-export.py`), and the pandas (`probe-cave-helpers.py` against a stub). The
wire format is `src/data/cave`'s business and is covered by `live.test.ts` there. The SeaTable
half *has* been run live, as above.

### The R Markdown exporter

`Save ▸ Export as R Markdown` writes the same graph as an `.Rmd` on **neuprintr, dplyr, nat,
ggplot2 and igraph**. `src/export/r/`, lazily loaded exactly like the notebook exporter, and it
gets its own chunk (`exporter-*.js` × 2 — verify both stay out of `main` with `pnpm build`).

**The two exporters share the fixture graph and the refusal policy, and nothing else.** The walk
is a **copy**, taken deliberately: a change to how R chunks are assembled cannot reach the
notebook. The cost is real and is the thing to watch — topological order, variable naming,
unwired-versus-blocked and where the notes land now exist twice, so **if you fix one, look at the
other**. What stops them drifting on *coverage* is `src/export/fixture.ts`: `everythingGraph`,
two golden files, and a node that emits Python but nothing in R shows up as a TODO rather than as
a document nobody noticed was shorter.

**The one place they have parted company is the backend.** `caveGraph` is the second fixture and
R refuses it outright — `canExportNotebook` is asked per language now, and
`DatasetFamily.notebook` names a client per language. That is a real coverage gap rather than a
loophole, and R's `export.test.ts` asserts the refusal so it cannot become a silent one; see
*The CAVE half of the notebook exporter* above. The refusal message points at the notebook, or
"no document can be built" reads as "Coda cannot export this at all".

**R's stack is the same lineage, which is why the mapping is clean** — navis is the Python port
of `nat`, and neuprintr is the natverse's neuPrint client. Three things are genuinely *better*
here: `neuprint_connection_table()` is query-relative, which is the shape Profile wants (so the
Connectivity emitter reorients *into* pre/post, the opposite direction to the Python one);
`neuprint_get_paths()` takes a hop budget, which `fetch_shortest_paths` does not; and
`neuprint_ROI_connectivity()` maps straight onto the ROI Connectivity node.

**One capability is missing outright: neuron meshes.** `neuprint_ROI_mesh()` reads ROI shells,
not neurons, so `neuron.meshes` emits a TODO pointing at the Skeletons node.

Four R-specific traps, each of which produces a document that looks right:

- **`neuprintr` publishes `bodyid`; every Coda table uses `neuronId`.** `df$neuronId` on a tibble is
  `NULL` rather than an error, so the mismatch travels silently until something reports zero
  neurons far from the cause. `coda_neurons()` normalises at every neuprintr seam; the helpers
  that read raw `neuprint_connection_table()` output keep its own names, which is the one place
  `bodyid` is correct.
- **`neuprint_fetch_custom` names columns after the RETURN expressions**, so a query without
  `AS` yields a column literally called `n.bodyId`.
- **knitr aborts a render on a duplicate chunk label**, which nothing in R's parser sees. Labels
  come from the walk's already-deduplicated variable names for exactly that reason, and
  `export.test.ts` asserts uniqueness.
- **A variable named `filter` or `select` masks the dplyr verb the next chunk calls** — and those
  are literally two node labels. `rIdent` suffixes `_df`; Python's builtin shadowing is a
  nuisance, this one breaks the document.

**`neuprintr` is not on CRAN**, so the setup chunk emits `remotes::install_github` for it and
`install.packages` for the rest — one line covering both would fail on the package the document
cannot run without.

**The R sample reproduces Coda's draw exactly**, and getting there needed care: R has no
unsigned 32-bit integer and `bitwOr` returns `NA` above 2^31, so mulberry32 runs in doubles with
explicit modulo and the two `|` operations are done arithmetically. Checked against the same JS
reference stream as the Python port — five seeds, identical.

`scripts/check-export.R` is the counterpart of the Python checker: it parses every chunk,
catches duplicate labels, and resolves functions where the packages are installed (skipped with
a notice otherwise, `--strict` to fail instead).

### Profile exports its metrics

`out.profile` is the one viewer whose translation is worth more than a pass-through, because
almost everything the card _shows_ is an ordinary roll-up rather than a drawing.
`coda_profile(body_ids, client, min_weight, top_n)` returns the tiles as named frames —
`summary`, `upstream_types`, `downstream_types`, `top_upstream`, `top_downstream`, `regions`,
`hemispheres` — ported from `nodes/lib/profileStats.ts`.

**It costs three requests however many neurons are asked for**, because `fetch_adjacencies` and
`fetch_neurons` both take the whole id list. The widget pages one neuron at a time and pays
three per neuron _viewed_, so the notebook can do the entire table for the price of the pinned
one — the emitted call passes the pinned neuron because that is what the canvas was showing,
and widening it is editing one argument. This is the one place the export is straightforwardly
better than the thing it exports.

Four rules came across with it, each of which produces a plausible wrong number rather than an
error, and each was cross-checked against the TS rather than trusted: untyped partners keep
their own bucket (merging them puts a fictitious type at the top of the list on male-CNS);
synapses are summed _and_ distinct partners counted, because forty synapses onto one neuron is
not forty onto forty; `roiInfo` nests, so regions are filtered to `fetch_primary_rois` before
summing or the totals roughly double; and a null type sorts **last** on a tie, matching
`collate`, which `na_position="last"` reproduces.

### Known gaps, all of them stated in the notebook

- **`Paths` with `Collapse types` on has no equivalent, and this one is not laziness.** Coda
  traverses the _type-collapsed_ graph, which finds `LC4 → PLP1 → DNp01` even where no single
  PLP1 neuron both receives from an LC4 and projects to a DNp01 — not recoverable by collapsing
  a neuron-level result afterwards, because the neuron-level search never returns either edge.
  Cypher cannot walk a derived graph without GDS, so neither `fetch_shortest_paths` nor
  `fetch_paths` can express it. Neuron-level mode exports.
- **The Network viewer hands over a `networkx` object with the layout commented out.**
  ForceAtlas2 has no drop-in twin, `spring_layout` is a different algorithm, and the
  hierarchical layouts need graphviz — a system package a generated notebook has no business
  requiring. Three options are offered as comments.
- **Upload Table names its file rather than carrying it.** The rows live in IndexedDB, so a
  `.coda.json` already arrives without them; the notebook emits `pd.read_csv("<filename>")`,
  which is the same accepted cost with the same honest statement of it.
- **Neuroglancer** emits a note: the URL is built from a published scene, which is a fetch this
  translation does not make.

## NBLAST, and Python in the tab

`neuron.nblast`, `Add ▸ Analysis ▸ NBLAST`. Skeletons in, a score matrix out — which is a
`MatrixValue`, so the Heatmap draws it, Normalize rescales it and Download writes the CSV,
none of which had to learn anything. The comparison is **navis-fastcore**, the Rust
implementation navis itself uses, running in the page as a Pyodide worker (`src/pyodide/`).

**This is a spike, and what it is spiking is the hosting cost rather than the algorithm.**
Every number below was measured rather than estimated — in Node against the wheel, and in
headless Chrome against `pnpm dev`.

### What it costs

| first use | raw | over the wire |
| --- | --- | --- |
| `pyodide.asm.wasm` | 9.6 MB | 3.44 MB |
| `python_stdlib.zip` | 2.5 MB | 2.5 MB |
| numpy | 2.92 MB | 2.92 MB |
| **navis-fastcore** | **1.10 MB** | **1.10 MB** |

About ten megabytes, **of which the algorithm is one** — nine tenths of that download is
CPython and numpy. That is the number to have in mind before adding a *second* Python-backed
node, and equally the reason the second one is nearly free. Measured in a browser: 2.3 s from
cold to a scored matrix, 536 ms for a 100 x 100 all-by-all once booted, 8 ms for eight neurons.

**Nothing enters the bundle.** Pyodide is not an npm dependency; the worker imports it from a
CDN at run time. `main` grew 6.3 kB — the node, its ops and the engine — and the worker is its
own 5.9 kB chunk carrying `nblast.py` inlined. Verify with `pnpm build`: `worker-*.js` should
contain `coda_dotprops`, and `main-*.js` should not match `jsdelivr` at all.

### The trap, which produces no error

**Coda's skeletons are nanometres; NBLAST's scoring matrix is micrometres.** The FCWB matrix
fastcore embeds runs out at a 40 um distance bin and past it every cell is about -10 — so a set
handed over in nm scores every pair as if no two neurons had ever been near each other,
uniformly, with nothing anywhere to say why. `NM_PER_UM` in `nodes/lib/nblastOps.ts` is the
whole of the fix and `nblast.test.ts` pins it. The related limit is that NBLAST **across**
datasets means nothing without a template-space registration, which Coda has no route to yet;
within one dataset it is exactly the usual analysis.

**So geometry now carries its units, and the conversion is checked rather than assumed.**
`GeometryUnits` (`core/values.ts`) rides on `SkeletonsValue`, `MeshesValue` and `PointsValue`,
`describeValue` prints it in the node footer — `12 skeletons · 43,210 pts · nm` — and
`checkNblastUnits` refuses anything that is not `nm` before a byte is marshalled.

Three things about it are load-bearing:

- **`voxelScale` answers `undefined` where it used to answer the identity**, and that is the
  change that made the rest possible. neuPrint returns voxels; the conversion needs
  `Meta.voxelSize` *and* a unit string the table recognises, and where either is missing the old
  code fell back to a 1:1 scale — which is indistinguishable from a dataset that genuinely
  publishes 1 nm voxels. So the failure was silent and, worse, unrecoverable downstream. Now the
  absence is the information: `geometryUnitsFor` sits beside `voxelScale` and turns it into
  `nm` or `voxels`, the two kept together on invariant 3's reasoning.
- **`voxels` is a real answer, not a failure**, and absent is a third thing again. The
  coordinates in that state genuinely are voxels — nobody here knows how big one is. Absent
  means unknown, which no source produces today, so NBLAST lets it through rather than refusing
  on a fact nobody stated. Same distinction as `columnSchemaFor`'s missing-versus-empty.
- **The units print even when they are the expected ones.** A line that shows up only when
  something is wrong is a line nobody learns to look at — the same reasoning that keeps the
  matched half of `unmatchedLabels` on screen.

Note what this does *not* catch, because it is a units check rather than a scale one: the mock
connectome is honestly `nm` and merely small, an 18 um brain against a real hemibrain's 250. The
bounds sanity check that would catch that is still unwritten.

### The k-NN sibling

`neuron.nblastKnn`, `Add ▸ Analysis ▸ NBLAST k-NN`. A different *question* rather than a faster
answer to the same one: a matrix asks how alike every pair is, this asks what one neuron is most
like — which is what a similarity search, a k-NN graph and an embedding all actually want.
fastcore shortlists candidates from a coarse voxel signature and scores only those, so the cost
is `n × nCandidates` rather than `n²`. **Every score returned is an exact NBLAST value**; only
which pairs were considered is approximate. fastcore's measurement, on 163,976 neurons: recall
of the true top 20 is 0.911 at 50 candidates, 0.969 at 100, 0.990 at the default 200, 0.996 at
400, having scored 0.16% of the pairs.

**It emits a long table** — `queryId`, `targetId`, `rank`, `score`, plus a label per side when
the picker is set — because that is the shape Filter, Sort, Download and `net.build` already
take. Building the graph here would be this node deciding merge rules `net.build` owns.

- **`queryId`/`targetId`, not navis's `query`/`target`.** `isIdentifierColumn` reads a name's
  last word to decide whether a number is an identifier or a quantity, so a column called
  `query` prints body 527536 as "527,536". The Python emitter renames navis's frame to match,
  or every downstream cell would address columns that are not there.
- **`idx` is cast to int32 in Python.** fastcore returns int64, and an int64 numpy array crosses
  to JavaScript as a `BigInt64Array` — which converts without complaint and then compares equal
  to nothing. `int32From` names that case in its error.
- **Padding is dropped and counted.** A row with fewer than `k` candidates comes back filled
  with `-1` / `-inf` to keep the arrays rectangular. Carried through, that is a neighbour called
  -1 with a score of negative infinity in somebody's chart.
- **A neuron present in both sets matches itself at 1.0**, which is fastcore's behaviour with an
  explicit target and is kept rather than corrected — so "top 5" is four others for such a
  neuron. Without a target, every neuron is excluded from its own row. The guide says so.
- **`symmetry` is applied before the top-k cut**, which is why it matters more here than on a
  matrix: once only k neighbours per row survive there is no transpose left to symmetrise
  against.
- **Two different things are called `k`.** fastcore's k-NN `k` is how many matches come back;
  its dotprops `k` fits the tangent vectors. On the card they are `Matches per neuron` and
  `Tangent neighbours`, in both nodes, because two controls called k is a card nobody can use.
- **`nat.nblast` has no equivalent**, so the R emitter is a TODO that says why: the honest
  translation is `nblast_allbyall()` plus a per-row top-k, which is the n² this node exists to
  avoid.

**What it does not yet buy is scale.** The Skeletons node refuses above 500 neurons and at 500
the full matrix is about seventeen seconds, so today this earns its place on the neighbour table
and the graph rather than on speed. It is the node that is ready when the fetch ceiling moves —
which is a decision about 5,000 HTTP requests against a shared production Neo4j, not about this.

### The bridge is about calling a function, not about NBLAST

`src/pyodide/` hosts **one** Pyodide instance — a module-level singleton in `engine.ts` — and the
protocol is `callPython({ module, fn, args })`. A capability is three things and no more: a
`.py` registered in `runtime.ts`'s `MODULES`, its request and result types, and a wrapper that
calls the bridge and reads the answer by name. `nblast.ts` is the first and the one to copy;
nothing in `engine.ts`, `worker.ts` or `types.ts` changes when a second arrives.

That shape was chosen over a message type per operation because the second capability is likely
(`linkage` for a Dendrogram is the named candidate) and the alternative grows a union without
bound. **The cost it avoids is not a protocol tidy-up but a second 10 MB runtime**, which is
what a separate engine would mean.

**A capability declares its own packages**, in `MODULES`, and they are installed the first time
something calls into it. Loading numpy and the 1.1 MB fastcore wheel from `boot()` instead
would be right only for as long as every capability wanted exactly those — the next one needing
scipy would edit the boot, and one needing neither would pay for the wheel. They go in as one
`loadPackage` call rather than two awaits: numpy comes from jsDelivr and the wheel from PyPI,
so serialised the second request's DNS, TLS and slow-start all wait on the first transfer. Worth
about 285 ms of a 2.1 s cold start, measured in a browser.

Four conventions carry it, each established against the runtime rather than assumed —
`scripts/probe-nblast.mjs` exercises all of them:

- **Arguments go over as they are.** A JS object arrives in Python as a dict through `.to_py()`,
  and a typed array nested inside one arrives as a buffer `np.frombuffer` reads directly. So a
  call passes one request object, the buffers are still transferred rather than cloned, and
  there is no marshalling layer to keep in step.
- **Results are a flat dict**: scalars and **one-dimensional** arrays, with any shape carried as
  its own entry. This is the one that bites. A 2-D numpy array does not fail to convert on the
  way out — it converts to a nested plain `Array`, which for a 400 x 400 matrix is 160,000 boxed
  numbers and nothing to say it went wrong. Hence `.ravel()` and explicit `rows`/`cols`, and
  `float64From` naming that case in its error.
- **`report` is the last positional argument** of every callable, `report=None` where there is
  nothing to say. A keyword would read better and would rest on `callKwargs`, which is more of
  Pyodide's surface to depend on for no gain.
- **A type crossing the bridge is a `type`, not an `interface`.** TypeScript gives a type alias
  an implicit index signature and an interface none, so an interface is not assignable to
  `PyArg` and the call fails to compile with a message about `undefined`. Not obvious from the
  error; worth knowing before writing the second wrapper.

`toJs` **copies** out of the wasm heap, checked rather than assumed — so a result outlives the
proxy it came from, while every proxy taken is still destroyed where it was taken.

### Decisions worth keeping

- **`nblast.py` is a real `.py` file**, loaded with `?raw`, not a template literal. It is
  readable and diffable, and `scripts/probe-nblast.mjs` (`pnpm probe:nblast`) runs *that file*
  against *that wheel* through *the same entry point the worker calls*. vitest has no Pyodide
  and jsdom has no `Worker`, so nothing in `pnpm test` executes a line of it — which is why
  `.github/workflows/pyodide.yml` does, path-filtered to `src/pyodide/**` and pinned to the
  Pyodide version `sources.json` names. Pinned rather than `latest` so a bump is a deliberate
  change with its own diff instead of an unrelated PR going red. The probe asserts the
  *contract* and not the scores — square result, flat float64, one finite score per pair, a
  self-match of exactly 1, progress actually reported. fastcore owns the numbers; this owns
  the marshalling.
- **The square case is one `nblast_allbyall` call, so no progress is reported from inside the
  blast.** Chunking the rows to drive a bar was measured at 1.8x (50-row chunks) to 5.1x
  (10-row) the run it would be reporting on, for byte-identical scores.
- **Cancel terminates the worker rather than interrupting Python.** Interrupting needs
  `setInterruptBuffer`, which needs a `SharedArrayBuffer`, which needs COOP/COEP headers, which
  GitHub Pages cannot set and which this app has no service worker to fake. Measured: abort
  lands in 153 ms, and the next run re-boots in 1.4 s because the ten megabytes are cached by
  then. The same missing headers are why it is **single-threaded** — `get_num_threads()` is 1 —
  so fastcore's headline multi-core speed is not available here whatever the backend.
- **Nothing is guarded that fastcore already handles.** Checked against the wheel rather than
  assumed: it clamps `k` to the point count, resamples a multi-rooted fragment with both roots
  surviving, and accepts a one-point neuron. So `dotpropSetFrom` drops nothing — a filtered set
  would put every label after the dropped neuron on the wrong row.
- **The score matrix says it is a similarity.** `MatrixValue.measure` (`'similarity' |
  'distance' | 'count'`) is the machine-readable half of `valueLabel`, and it exists because
  clustering needs *distances*: somebody has to know to invert, and in the consumer that is a
  special case per producer. Optional, and absent means unknown — Pivot genuinely cannot say,
  since its cells are whatever aggregation was picked — so a consumer asks and carries on when
  nobody answered. Only NBLAST sets it today.
- **No param is presentational**, which is unusual enough here to be worth saying. Every one
  changes the scores, `Label by` included: the labels are part of the matrix that leaves the
  port, not a way of drawing it.
- **The wheel tag is not Pyodide-specific.** `pyemscripten_2026_0_wasm32` is the emscripten ABI
  tag and Pyodide 314.x's lock declares `abi_version: 2026_0`. `sources.json` pins both, because
  a Pyodide bump that moves the ABI needs a wheel built against it.
- **CORS was checked with an `Origin` header, and that mattered.** `files.pythonhosted.org`
  sends no CORS headers at all to a bare `curl -I` and `access-control-allow-origin: *` to a
  request carrying `Origin` — so the wheel loads in a browser, which the obvious check says it
  does not. Same shape as the `/api/roimeshes` HEAD-vs-GET finding. jsdelivr is open either way.

### What is not settled

The CDN is a third-party runtime dependency this app otherwise does not have; the wheel is
1.1 MB and could sit in `public/` while the runtime is still borrowed. And the honest way to
price the whole thing is not "ten megabytes for NBLAST" but "ten megabytes for a numerical
backend" — `linkage` (the Dendrogram TODO), the CMTK/Elastix/TPS transforms (the template-space
TODO), geodesic distances and Strahler for morphometrics, and "custom nodes using Python" all
come out of the same download. Judged as one node it is disproportionate; judged as a backend it
is cheap. That is the decision the spike exists to inform.

**The second capability has now landed and the prediction held.** Clustering (below) is
`linkage.py` plus a wrapper plus a line in `MODULES`, and it costs **2 ms** on a runtime that
has already run NBLAST — measured, against 366 ms for the first module, which is almost
entirely its `import numpy` / `import navis_fastcore`. Its packages cost **0 ms**, being the
same two. So the honest price of the *third* Python-backed node is a few kilobytes of source,
and the ten megabytes stays a one-off for the backend rather than a tax per capability.

## Clustering: Linkage, Cut Tree, Dendrogram

`cluster.linkage`, `cluster.cut` (both `Add ▸ Analysis`) and `out.dendrogram`
(`Add ▸ Visualisation`). NBLAST answers how alike every pair is; these answer what the
*groups* are. `NBLAST → Linkage → Cut Tree → Dendrogram` is the chain, and each arrow is a
separate act rather than a step of one: the tree is computed once and expensively, the cut is
somebody trying a number and looking at the picture, and the picture is free.

The comparison is **navis-fastcore** again — `fc.linkage`, `fc.leaf_order` — through the same
Pyodide bridge, as the second capability on it.

### The value kind, and why not a table

`LinkageValue` (`core/values.ts`) carries SciPy's `Z` ravelled, the labels, the leaf order and
optionally a cut. It is its own `CodaType`, on **`LayoutValue`'s exact argument**: a linkage is
not data about neurons, it is a tree computed *for* one particular set of them. As a table of
`[a, b, height, size]` it would accept any four numeric columns, need four pickers to
configure, and be silently destroyed by a Sort upstream of whatever drew it — none of which a
reader would connect to the wrong picture they got.

The socket takes the matrix hue and the one shape that family had left (`ring`). A sixth
chromatic family would fail the all-pairs colourblind gate; see `colors.ts`.

**`clusters` is optional on the value, and absent means _not cut_ rather than _one cluster_** —
the distinction `MatrixValue.measure` draws. `cluster.cut` sets it, which is what lets a
Dendrogram wired *after* a Cut colour its branches by group with no second input and no column
picker.

### Verified against the reference rather than assumed

Four findings, each of which was a wrong answer before it was checked. All were established
against scipy 1.15.3, R 4.4.1 and the real fastcore wheel, not recalled.

- **fastcore's linkage _is_ SciPy's.** Merge order identical on every one of 60 trials across
  the five methods, heights agreeing to 1.3e-15, and `fc.leaf_order` identical to
  `scipy.cluster.hierarchy.leaves_list` on 20/20 random matrices. That is what makes the
  notebook export a translation rather than a second implementation to keep in step, and it is
  worth knowing before anyone reaches for a hand-rolled clustering here.
- **`centroid` and `median` produce non-monotonic trees, and are not offered.** Measured on
  random NBLAST-shaped matrices, 25 observations, 40 trials: `centroid` inverted in **39 of
  40** and `median` in **40 of 40**, where `ward`, `average`, `complete`, `single` and
  `weighted` inverted in none. A merge below its own child cannot be drawn honestly — and both
  are defined on *squared Euclidean* distances, which `1 - NBLAST score` is not, so they were
  offering a wrong answer as well as an undrawable one. Their absence is also what makes the
  cut below sound: on a monotonic tree, row order *is* ascending height order.
- **`fcluster(..., 'maxclust')` is the wrong function for "give me k groups".** It finds the
  lowest height leaving *at most* k clusters, so on six observations in three tied pairs it
  answers three clusters for k = 2, 4 and 5 alike. `cut_tree(Z, n_clusters=k)` undoes the last
  k − 1 merges and returns exactly k, which is what `cutByCount` does — and the two agreed on
  every one of 300 comparisons across the five methods offered, against 45 disagreements in 120
  across the two that are not. A spinner marked "Clusters: 4" that yields 3 with nothing saying
  why is the silent surprise this codebase exists to avoid.
- **R's `hclust` mapping, all five, through both implementations on one matrix**:
  `ward`→`ward.D2`, `average`, `complete`, `single`, `weighted`→`mcquitty`, reproducing the
  merge heights and the leaf order exactly. `ward.D` is the older variant of Ward's criterion,
  disagrees on the same data, and errors nowhere.

### Cluster numbers are ours; the partition is SciPy's

**Clusters are numbered left to right as the dendrogram draws them**, so cluster 1 is the
leftmost group and the column reads against the picture. That is a deliberate divergence, and
it costs nothing: SciPy's own two cut functions do not agree with *each other* on numbering, so
there was never a convention to match — only a partition, which does match exactly. Both
exporters renumber (three lines of pandas, one of R) so the notebook and the canvas agree.

### Two bugs a browser found, and jsdom could not

Both were invisible to a green suite of 2,498 tests, and both are the class this codebase keeps
being caught by. They are recorded at length because the *symptom* points nowhere near the
cause in either case.

- **A matrix of counts becomes negative distances, and the tree draws off the card.** `auto`
  reads a matrix that says nothing as similarities, so an Adjacency of raw synapse counts gives
  `1 - 77 = -76`. fastcore clusters negative distances without complaint; the viewer then
  normalises against a maximum it is nowhere near, and the brackets project to **x = 42,423 on
  a 550-pixel card**. Nothing throws, nothing logs, the node goes green, and the caption's
  counts are all correct — the drawing is simply not there. The comment that used to sit on
  `transformFor` predicted the opposite symptom ("it comes out inverted rather than subtly
  off"), which is exactly why the guess is now *checked*: `checkLinkageDistances` scans the
  cells before anything is marshalled and names the two fixes, which are opposite — counts want
  a Normalize upstream, un-normalised NBLAST scores want the switch back on at the NBLAST node.
- **A selection held as labels lit two thirds of the tree.** Leaf labels are whatever named the
  matrix, and `NBLAST → Label by: type` makes them repeat — fourteen neurons, five distinct
  names. A branch was drawn as selected when *every leaf under it* was in the selected set, so
  picking one three-leaf clade lit every branch that happened to share a name with it. The
  caption said "3 selected" throughout, which is why no assertion on it would have caught this.
  The selection now holds **observation indices**, which are unique by construction; the cost
  is `core.selectOne`'s trade, that a position is not an identity — and it is forced rather
  than chosen, since a tree offers no stabler handle for a leaf, only a less honest one.

### The traps

- **The matrix is copied before it crosses the bridge**, and this is the one that would have
  been a live bug. `callPython` *transfers* every typed array in a call's arguments — right for
  the point buffers NBLAST builds and drops — and this one is the upstream node's own cached
  result. Transferred, it is detached: the Heatmap an inch away redraws empty, the scheduler's
  cache holds a zero-length array, and nothing connects either to the node that ran. 500 × 500
  is 2 MB, which is what the copy costs.
- **A square matrix is not necessarily over one population.** NBLAST with a Target set of equal
  size is perfectly square, and clustering it would treat row 3 and column 3 as one observation
  because they share an index. `checkLinkageInput` compares the row and column labels and
  refuses, naming that case — the only check in the module that is about meaning rather than
  arithmetic.
- **`as.dist` reads the _lower_ triangle where `squareform` reads the upper.** Identical on a
  symmetric matrix and the transpose of each other on one that is not, which is exactly the
  `Symmetry: none` case. The R emitter says so rather than quietly disagreeing with the
  notebook.
- **SciPy's `dendrogram(orientation=)` is named for where the _root_ goes, not the leaves**, so
  Coda's "leaves on the right" is `'left'`. R's `horiz` was measured rather than read: reading
  `par("usr")` back, `horiz = TRUE` runs the height axis from 0.568 down to −0.022, i.e. root at
  the left and leaves on the right, so both map with no flip. Getting either backwards produces
  a mirrored picture that looks perfectly reasonable.

### The second output is most of a clustermap

`Linkage` emits `Ordered` as well as `Tree`: the input matrix with rows and columns permuted
into leaf order. Wired to the **existing** Heatmap that is the block-diagonal picture, with no
new drawing, no second colour scale to keep in step, and one permutation of a `Float64Array` to
pay for it. It is the *scores* reordered rather than the distances the tree was built from —
what somebody wants to look at is the matrix they have, arranged so its structure shows.

### The drawing

`DendrogramViewer` is **SVG rather than canvas**, which is the opposite of `ScatterViewer`'s
call and for the opposite reason: a scatter is fed by an embedding of a whole dataset, where
this is bounded by `MAX_LINKAGE_OBSERVATIONS` and by what a reader can take in. What SVG buys
is the whole export path free (`ViewerActions` clones the live `<svg>`), hit testing on every
branch with no quadtree, and labels the browser lays out.

- **Clicking a bracket selects the leaves under it**, which is the gesture the drawing exists
  for — a clade is exactly the thing somebody wants to pull out and look at in 3D, and it is the
  one selection a table cannot express because it is a fact about the tree. The range is exact
  rather than approximate: the leaf order is a depth-first walk, so every subtree is a
  *contiguous run* of it and a click is `order.slice(first, last + 1)` however many thousand
  leaves hang off it. **What is stored is positions, not names** — see the browser findings
  above — so both exporters map indices back to labels, and R's do it one-based.
- **A branch selects; it does not cut.** The cut lives one node upstream where it is a stored
  number everything downstream can see. A viewer that also cut would be a second answer to the
  same question with nothing saying which won.
- **Colours cycle past the eighth cluster, and the caption says `colours repeat`.** Everywhere
  else here a ninth category takes the achromatic Other colour, because in a legend a repeated
  hue claims two series are the same thing. A dendrogram is the case that rule does not fit:
  clusters sit in leaf order along one axis, so two sharing a hue are visibly far apart and the
  number in the table is the identity — where greying everything past eight leaves a
  twenty-cluster cut with no picture at all. Admitted rather than hidden, on the `labels
  thinned` idiom, which the same caption also carries.
- **Geometry is in unit space** (`dendrogramLayout.ts`, headless), so orientation is a
  projection at the end rather than two layouts that can disagree.

### Newick, because a `Z` matrix is not a file anyone can open

A linkage exports as **Newick** by default — read by iTOL, FigTree, ete3, ape, dendropy and
Biopython — with the linkage matrix itself offered as CSV for going back into SciPy or R.

**Branch lengths are differences, not heights**, and that is the trap: a Newick branch is the
edge *below* a node, so it is the parent's merge height minus this node's. Writing the absolute
height instead produces a file that parses, draws, and is wrong in a way only a scale bar
reveals. Verified with biopython rather than by eye — it reads the output back ultrametric,
every root-to-leaf distance equal to the top merge, and each pair's path distance exactly twice
its merge height. Labels carrying `(`, `)`, `,`, `:`, `;` or a space are quoted with an internal
quote doubled, since `SMP001(a)` would otherwise close a clade mid-name.

### Getting back to neurons: the two bridges

`cluster.selectedToNeurons` and `cluster.clustersToNeurons`, both `Add ▸ Transform`. A
`LinkageValue` knows its leaves only by **label**, because that is all a `MatrixValue` axis
carries — so a Dendrogram's `Selected` and a Cut Tree's `Clusters` are tables of *names*, and
everything that draws neurons wants `T.neurons()`. These cross that gap.

**Two registrations over one operation** (`lib/labelsToNeurons.ts`), which is unusual enough
here to say out loud. They take the same inputs, run the same function and emit the same shape;
what differs is the name, what the input socket says, and one edit-time warning. The case for
two is discoverability — somebody holding a Cut Tree looks for a node named after what they
have — and the cost is paid once rather than as two implementations that drift.

**Matched locally, never queried.** The neurons come from a table already on the canvas, so a
clade of three cell types resolves to the neurons that were *clustered* rather than to every
neuron of those types in the connectome. That is a different question and `IDs from Label` is
the node that asks it. With no Neurons wired the labels are read as neuron ids, which is what
they are unless NBLAST was told to label by something else.

Four things in it that each produce a plausible wrong table:

- **Matched as text**, the `String(cell)` rule `joinTables` follows. An NBLAST labelled by body
  id produces the *string* `"722817260"` against an `i64` column, so comparing by value fails on
  the default wiring rather than on an exotic one. Both exporters cast into a scratch key for
  the same reason — a plain `left_on`/`right_on` merges nothing at all there, with no error.
- **The neuron table drives order and count.** One label naming six neurons gives six rows,
  which is the point when the labels are types; a repeated label takes the first row rather than
  the cross product, which `drop_duplicates` and `distinct` reproduce.
- **Every column survives**, with a collision suffixed as `Join` does. Visible on a real graph:
  a neuron table's own `size` puts the Clusters table's `size` through as `size_c`.
- **A wrong `Match on` is otherwise silent** — an empty table with every count correct. The card
  says `4 labels · 0 neurons · ⚠ 4 matched nothing`, derived from the run for the reason
  `unmatchedLabels` is: there is no channel from `evaluate` to a badge that survives a result
  being restored from cache.

**Known gap: `Skeletons` does not carry extra columns.** It fetches from the dataset, so a
`cluster`/`color` put on a neuron table does not survive `Clusters to Neurons → Skeletons → 3D
View` — the picker there reads `color (missing)`. Neuroglancer takes the neuron table directly
and is unaffected. Closing it means joining the input table's extra columns onto the fetched
attributes, which is a change to a fetch node every graph uses and has not been made.

### `literal`: colours somebody else already chose

A fifth `ColorMode`, opt-in per node via `colorParams({ allowLiteral: true })`, offered today by
Neuroglancer, the 3D view, the Network and the Scatter. The cells **are** the colours.

**It exists because `categorical` cannot reproduce a dendrogram.** `resolveColor` ranks values
by frequency so the commonest takes the leading slot, then folds everything past eight into one
achromatic bucket. `clusterColor` assigns `(cluster - 1) % 8`, by number, cycling — so the two
agree only by luck, and "colour Neuroglancer by cluster" hands the biggest group the hue the
first group was drawn in. Hence `out.dendrogram`'s `Selected` carries a **`color`** column
beside its `cluster`, and something has to be able to honour it.

- **`clusterColor` is shared** between the viewer and the node. Two copies is a tree whose
  branches disagree with the neurons it sent to a 3D view; the node reaches into `src/ui` for
  it, which is the licence `out.neuroglancer` already takes for `resolveColor`.
- **The emitted hex is the _dark_ palette, pinned.** `evaluate` must be deterministic
  (invariant 4) and a cache key does not change when somebody flips the theme, so resolving from
  `currentMode()` would go stale with nothing to invalidate it. Dark because that is where the
  colours are going — neuroglancer renders on black. The cost, stated: on a light canvas the
  tree's own branches take the light ramp, a shade off the hex in the column.
- **`cluster` and `color` are always present**, 0 and the achromatic ink where nothing has cut
  the tree. A schema that gained and lost them as a Cut Tree came and went would silently empty
  every picker pointing at them — `neuron.connectivity`'s rule for its own `hop` and `direction`.
- **A cell that is not a colour goes grey rather than being coerced.** `#rgb`, `#rrggbb` and
  `#rrggbbaa` only; a column of cell types under this mode is a mistake, and hashing the text
  into a hue would produce a picture that looks deliberate.
- **No legend.** A hex is not a name, so every swatch would be labelled with the colour beside
  it.
- Both exporters carry a third companion (`<tree>_clusters`, `NULL`/`None` from Linkage and the
  cut from Cut Tree), since neither SciPy's `Z` nor R's `hclust` has anywhere to put a cut. The
  palette is read off `clusterColor` rather than transcribed — an emitter may reach `src/ui`,
  which is half of why the emitter registry is separate from the node definitions.

### What it costs, and what is not verified

**+18.6 kB raw / +6.1 kB gzipped on the main chunk**, measured against a build of the same tree
with the feature absent (976.00 → 994.59 kB). The Pyodide worker grew 9.5 → 13.1 kB, carrying
both `.py` files inlined; `main-*.js` still matches `jsdelivr` nowhere. Well under this
codebase's bar for a lazy boundary (the exporters, at 17.6 kB gzipped).

Clustering is **free next to the comparison it follows**: measured in Node against the real
wheel, 400 observations in 2–4 ms and 2,000 in 33 ms, against roughly seventeen seconds to score
500 neurons in the first place. `scripts/probe-linkage.mjs` (`pnpm probe:linkage`) runs
`linkage.py` against that wheel through the same entry point the worker calls and asserts the
*contract* — one merge fewer than observations, flat float64, `order` as int32 rather than the
int64 numpy holds it in, heights ascending, no merge referencing a later cluster — plus one
structural check on a planted two-block matrix, which is the cheapest thing that would catch a
matrix handed over transposed or as similarities where distances were meant.

### What was checked in a real browser

Headless Chrome over CDP against `pnpm dev`, driving a shared-link graph of
`Mock hemibrain → Find Neurons → Skeletons → NBLAST → Linkage → Cut Tree → Dendrogram` with the
ordered matrix going to a Heatmap. That is also the only place the **worker runs two Python
modules in one session**, which nothing in the suite covers: NBLAST boots the runtime and
clustering arrives into it, both landing inside two seconds.

Verified: fourteen leaves and thirteen brackets, merge heights to scale, both orientations
(labels rotated under `down`, all fourteen inside the plot in both), the three clusters coloured
with the branches *above* the cut in neutral grey, the caption, the styling rail in the overlay,
a click lighting exactly the clade under it and nothing else, and no console errors. Both bugs
above came out of this pass.

The **light theme** was driven too, and comes out of the palette rather than out of a literal:
surface `#fcfcfb`, the three cluster hues from the light categorical ramp, `#898781` above the
cut and `#52514e` on the labels — all through `currentMode()`, `CHART_INK` and `seriesColor`,
which is the only reason a viewer computing hex in JS survives a theme switch at all.

What has **not** been looked at is a tree at the few-hundred-leaf end, where the label thinning
actually bites, and the `Ordered` matrix beside a Heatmap at a size where the blocks matter.

## Annotations, and telling backends apart

Two things landed together because the second is what the first made necessary: neuron labels
can now come from somewhere other than the connectome, and a dataset node now says which backend
serves it.

### Where a neuron's labels come from

`src/data/annotations/`. A **CAVE dataset node has an Annotations socket**, and what is wired to
it *replaces* the datastack's own labels. Sources **chain** — each has its own optional
Annotations input — so `CAVEtable → FlyTable → Dataset` is one socket on the dataset and a
visible sequence on the canvas, with a later source winning a name collision. What travels is an
ordinary neuron table, so a Filter, a Sort or a Select can stand anywhere in that chain and a
Table node beside it shows what actually arrived; see **the Annotations socket** below for why
that is not a bespoke type.

**neuPrint has no such socket**, and that is `DatasetBackend.acceptsAnnotations` rather than a
type check: neuPrint carries its cell typing as properties on the neuron, so there is nothing for
a source to replace and the control would change nothing. A CAVE datastack takes its labels from
a table — which is exactly what an annotation source *is* — and for several datastacks there is
no such table at all. Aedes publishes synapses and nuclei and no annotations whatsoever.

**Three nodes over two providers**, which is `labelsToNeurons`' call again: `FlyTable` and
`SeaTable` are the *same API at two hosts*, so they share a client and differ in the host they
default to and the name somebody looks for.

**Two column names are Coda's, and a chain has to land on both.** `neuronId` was obvious — an id
column is whatever the base calls it and every provider renamed onto it from the start. `type` was
not, and missing it is entirely silent: `typesOf` reads `index.data.type` by literal name, so a
chain publishing `cell_type` leaves `neuronType`/`partnerType` null on **every** connectivity row
while the schema still declares them, Explore's `PRIMARY = ['type', 'instance']` falls through to
a guess, and Profile's type roll-ups empty. `annotationColumn` in `annotations/types.ts` is the
rule, applied by both providers — the same statement `data/cave/schema.ts` makes for the
datastack's own table (`{ pt_root_id: neuronId, cell_type: 'type' }`), since an annotation chain
is just the other route to the same neuron table. Deliberately only those two: everything else is
a passthrough only a column picker ever names, which is what neuPrint's `PROPERTY_NAMES` does for
`cellBodyFiber` and `somaSide`.

**What a chain does to a schema is one function, `withAnnotations`**, and it lives in `src/data`
because both halves of the seam need it: the edit-time half runs in `src/nodes` (`schemasFromType`,
so a picker knows what to offer) and the run-time half in `CaveSource` (so the table it builds
matches), and `src/data` may not import `src/nodes`. Written twice they had already drifted — one
took the id column off the source's own schema and the other hardcoded `str`, agreeing only
because every CAVE schema happens to declare `str` today. Invariant 3 in the direction nothing
type-checks. `chainSchema` and `joinAnnotations` are the same pairing one level up, and share
`joinedSchema` for the same reason.

**The chain reaches the source, not the graph.** Every request that names a dataset carries it —
find, index, connectivity, adjacency, geometry — because a `DataSource` has no view of the graph
and the chain is a fact about the wiring. `datasetRequest(dataset)` returns the **id and the
annotations together**, so a call site cannot supply one without the other.

That pairing is the fix for a real failure rather than a precaution. The first pass threaded the
chain into the *type* and only partly into the values: `findNeurons` never forwarded it at all,
`schemasForDataset` did not substitute where `schemasFromType` did, and the morphology attribute
table was built from the datastack's schema. So three query nodes advertised the chain's columns
and returned the backend's, both morphology nodes did the same, and a second complete 139,255-row
index was built and cached under the unannotated key. Invariant 3 across a seam, silent, and only
findable by reading every caller — which is why the id and the labels now travel as one thing.

**A chain wired but not yet run means the widget waits, rather than loading.** The *type* says a
chain is there the moment the wire is drawn; only the value carries its table. Loading anyway
downloads the whole index under the unannotated key and again under the annotated one the instant
a Run lands — on FlyWire, 139,255 rows and about seven seconds thrown away, both retained for the
life of the tab since the shared entry map is never evicted — and the list it shows meanwhile
carries the backend's labels, which is the gap the chain was wired to close. Read off the type,
which also retired a match on the *text* of `CaveSource`'s refusal: that coupled the empty state
to a sentence in `src/data` and recognised only CAVE's phrasing.

**The Explore widget reads the chain off the _value_, one run later than the ports do.** A
dataset *type* carries the chain's schema; only a `DatasetValue` carries its table, because that
table is a fetch somebody's Run paid for. So `NodeBodyProps` gained `inputValues` — the same
thing `ValuePreview` is handed, from the `nodeInputs(id)` the card already computed — and
`useNeuronIndex` takes the chain and keys its shared entry on it, for `neuronIndexKey`'s reason.

That is a real departure from "this widget loads independently of any run", and it was forced
rather than chosen. It began as a labelling gap — an annotated CAVE dataset listed the backend's
`type` while the wire carried the chain's columns — and became a **hard failure** the moment
`DatastackSpec.neurons` was allowed to be absent: on a datastack that publishes no neuron table
the chain *is* the list, so the widget had nothing to list and the source refused. Aedes is
exactly that datastack, and it is the case the whole feature exists for.

The departure is bounded to what cannot be had otherwise: with nothing wired, or before a run,
the widget behaves exactly as it always did. And the pre-run state is drawn as an instruction —
`Press Run to load this dataset's neurons` — rather than as the source's own sentence, which
would send somebody to look at the dataset when the fix is a keypress. That recognition matches
on the refusal's *text*, which is the thing `reportAuthFailure` exists to avoid; it is
deliberately narrow (it only softens wording, and a real refusal still shows through) and the
honest fix is the per-dataset capability that is still unwritten.

**The Profile widget looked like the same gap and was not**, which is worth the sentence: it
fetches per neuron rather than loading an index, and `ValuePreview` hands it a whole
`DatasetValue` and then peeled two strings off it. So the chain now rides along, and the profile
cache key carries it for `neuronIndexKey`'s reason — two graphs on one datastack with different
annotations hold different answers, and without it the first one looked at is served to the other
for the session. It matters on precisely this card because it is the one surface that prints a
partner's *type* in words beside ports carrying the chain's.

**A repeated root id is kept by the providers, and collapsed only where it has to be.** Both
`shapeRows` and the CAVE table reader used to drop a repeat, on the stated grounds that it "would
put that neuron in the index twice" — which was already answered downstream and always had been:
`dedupedIds` fixes the row order and `annotationIndex` fixes the cells, both first-occurrence-wins,
and `joinAnnotations` does the same per side. So collapsing it at the provider changed nothing a
Dataset ever saw. What it did was hide, from the only person who could act on it, that their base
disagrees with itself.

Measured against FlyTable's `main.info`: **58,340 rows over 56,309 distinct ids, 1,089 neurons
carrying more than one, and one segment appearing 104 times** with its `side` reading left, center
and center among them — a proofreading merge pulling many old annotations onto one root id. "First
wins" was picking one of those 104 by arrival order, silently. Now the repeats reach a Table node,
and a Sort ahead of the Dataset decides which row wins instead of the order the API happened to
return. `cave.test.ts` pins the downstream collapse, since that is what the providers now lean on.

**And the change did not appear to ship, because the cached table outlived it.** An annotation
table is kept for a month and the fingerprint was the ref key alone — which says what was *asked
for* and nothing about how the answer was built, so no change to the shaping rules invalidated a
single stored entry. A session that had read `main.info` before went on reporting 56,309 rows,
with `Refresh` on the node the only way through. `SHAPE_FORMAT` in `annotations/registry.ts` is
now part of the fingerprint. Same trap and same fix as `MASK_FORMAT` on the thumbnail cache — an
entry that outlived the policy that produced it because nothing in it recorded which policy that
was. In the fingerprint rather than the key, because a fingerprint mismatch is a miss that
*overwrites*, and there is only ever one current shape.

**"Shaping" is a precise thing, and the rule is: bump when the same reply would now produce a
different table.** Which rows survive, what the columns are called, what dtype each gets, how a
cell is narrowed, whether a long table is folded. *Not* how the fetch was made — paging, routes,
retries and credentials all leave the same table behind, and none of them belong in the
fingerprint.

**And it is coupled rather than remembered.** `shapeRows`, `wideRows` and `pivotRows` each have
their decisions asserted in `annotations.test.ts` — those blocks *are* the operative definition —
and one test in the same file asserts `SHAPE_FORMAT` itself. So changing shaping fails a test,
and bumping the constant alone fails a different one that points back at the blocks. Both
directions were confirmed by mutation. Without that pairing the constant is a comment, and a
version somebody has to remember to bump makes the cache look guarded when it is not. It is also
what made `pivotRows` and `wideRows` worth exporting: `shapeRows` already was, and a shaping rule
nobody can call is a shaping rule nobody can pin.

Note the asymmetry those tests record. `wideRows` keeps a repeated root id; `pivotRows` cannot,
because many rows per neuron is its *input* shape — one row per (neuron, kind, value) is what
`pivotOn` exists to fold, so the Map keyed by id is the operation rather than a dedup on top of
it.

**`CaveSource` left-joins the chain onto its own neuron list**, and the direction matters: every
neuron the segmentation knows about comes out, annotated or not. The other way round would let an
annotation base decide which neurons *exist*, and those bases routinely carry rows for ids that
have since been edited away — putting neurons in the index the connectome cannot answer a single
query about. The index cache key carries the chain, or two datasets differing only in their
annotations would share one cached table and the first one fetched would win for the session.

**Where a datastack publishes no neuron table at all, the chain _is_ the list** — which is not
that decision reversed but the case it does not cover. `DatastackSpec.neurons` is optional, and
Aedes is the example: synapses and nuclei and nothing that enumerates neurons. With no
segmentation list there is nothing to left-join onto, so `idsFromChain` takes the order from the
chain's own `neuronId` column, deduplicated for `orderOf`'s reason — an annotation base is
somebody's spreadsheet and can hold two rows for one neuron. Combining populations is then two
annotation nodes chained rather than a setting, because `joinAnnotations` is a full outer join:
`CAVE table (proofread_neurons) → FlyTable (info)` is the union of both id sets.

**What that table is actually for is worth stating, because it is narrower than it looks.**
Nothing queries *through* it. It is read for exactly two columns — the root id, which becomes the
index, and the annotation table's own primary key, which is how `spec.annotations.refColumn`
joins back — so `spec.annotations` depends on it and a datastack with neither is coherent.
Connectivity reads the roll-up view by root id, and Skeletons, Meshes and Synapses take ids off a
table, so `Input IDs → Connectivity` needs no neuron table whatsoever. What its absence costs is
enumeration: Find Neurons, Explore, and the type names `typesOf` puts on every connectivity row.
Hence the refusal names the wire to make rather than answering with an empty table, which would
read as a datastack with no neurons in it.

The node follows: `Neuron table` is no longer required, its help says any table with one row per
neuron carrying a root id will do, and `validate` asks for **a table or a wire** rather than for
the table. `registerCustomCaveSpec` registers the spec either way — withholding it for want of a
neuron table would break the id-driven nodes, which never touch it.

**The CAVE table node's Dataset input is optional, and that is not a convenience.** It was
required, which made the wiring the node's own guide describes — a datastack's table handed back
to that datastack as its labels — a **cycle**: `Dataset → CAVE table → Dataset` is two edges
between one pair in opposite directions, so `topoSort` returns both nodes in `cyclic` and the pair
goes dark with no result and nothing naming the cause. So the datastack is a param
(`flywire_fafb_public:783`, the `datasetIdFor` grammar) and the socket is the *override*: wired, it
names a different datastack to read the table out of, which is the cross-datastack case and the
only one the wire was ever needed for. Found by writing the node's first test, which is exactly
the gap invariant 5's corollary records about `out.barChart`.

### SeaTable, verified rather than read

Everything here was probed live against FlyTable. Four calls, and the auth scheme is **`Token`**,
not `Bearer`, on every one — a Bearer JWT gets `403 invalid token`, which blames the credential
rather than the scheme.

```text
GET  {host}/api/v2.1/workspaces/                                → bases, by workspace
GET  {host}/api/v2.1/workspace/{ws}/dtable/{base}/access-token/ → JWT + uuid + dtable_server
GET  {server}/api/v1/dtables/{uuid}/metadata/                   → tables and their columns
GET  {server}/api/v1/dtables/{uuid}/rows/?table_name=…&limit=…  → the rows
```

- **An account token, not a base API token**, and the distinction cost four failed probes. The
  documented "app access token" exchange takes a token minted *for one base*; an account token
  answers `Permission denied` there and works everywhere else. It is also the better credential
  to ask for: one reaches every base the account can see. The message says so, because the
  server's does not.
- **The rows endpoint has no column selection, and the one that does cannot be reached from a
  browser.** `/dtable-db/api/v1/query/` takes SQL and answers 200 — with no ACAO header. So a
  whole-table read is every column: FlyWire's `main.info` is 58,340 rows over 60 columns at
  **~79 MB**, in six pages of 10,000, and **SeaTable does not gzip**. The node's `Columns` param
  changes what is *kept*, not what is transferred. Cached in IndexedDB, so it is paid once per
  base; measured end to end at **19.8 s**.
- **Ids are already text.** `root_id` comes back as `"720575940621522189"`, so it round-trips
  exactly and meets CAVE's string ids with no conversion. That is the half of invariant 8 that
  was free, and it is why these two backends join at all — the live test asserts most of a
  sample is genuinely beyond double precision, because an id merely *ending* in zeroes proves
  nothing.
- **Pages are sequential, not concurrent.** `start` is an offset into a base that is being edited
  while you read it; firing six at once is how a page gets read twice and another missed.
- **The workspace is worked out, not asked for.** A base is addressed by workspace *and* name,
  which is the API's bookkeeping rather than anybody's question — measured on the real FlyTable
  account, **46 bases across 13 workspaces and not one duplicated name**, so the field was never
  once needed there. Empty now resolves from the listing and only genuine ambiguity is refused,
  naming the workspaces rather than picking one. Exact match first, then case-insensitively,
  because a base name is something people retype; the ambiguity rule guards both passes, so the
  second cannot quietly choose between two bases.

  `discovery` is keyed on `host|base` and deliberately **not** on the workspace as typed: the peek
  runs on the typed config and the run on the *resolved* one, so with the workspace usually empty
  the two never met and inference paid its own access-token-plus-metadata round trip per base for
  an entry the run had already filled. A base name that is ambiguous is refused rather than
  resolved, so the name alone identifies whatever was successfully opened.

  Three things about it. The **resolution happens before the cache key is taken**, so `main` and
  `5 / main` are one entry — `main.info` is ~79 MB, so keying on what somebody typed rather than
  on what it means is a second twenty-second download and a second copy in IndexedDB. A ref that
  *names* its workspace **never lists at all**, which is a round trip saved and an account whose
  `/workspaces/` is slow or forbidden still able to open a base it has the id for. And
  `peekBases` — which `validate` reads — is the one peek here that **starts no fetch**: it runs on
  every graph mutation and would otherwise issue a listing, and with no token an auth-failure
  popup, for a node somebody is still typing into. In practice it is loaded by the time it
  matters, because `peekColumns` resolves the same base.

  It also fixes a card refusing over something it does not draw: `workspace` is `advanced`, so
  the old requirement was a badge pointing at an inspector-only field.

**FlyTable cannot be read from a browser at all, and the live test could not see it.**
`live.test.ts` runs in Node, where `fetch` does no CORS enforcement — so "probed live" covered
every endpoint shape and none of the browser's actual constraint. Measured against the
deployment: **zero `Access-Control-*` headers on any response**, and the `OPTIONS` preflight
reaching Django and answering `403 Authentication credentials were not provided` before any CORS
middleware could run. Not an allowlist — four different `Origin` values produce the same nothing.
`cloud.seatable.io`, the same software hosted, answers the preflight 204 with
`Access-Control-Allow-Origin: *`, so the two deployments differ entirely in this and the code
cannot assume either.

So `request` **tries and remembers**. That machinery is now **one module**, `data/routeMemory.ts`
— it was written by hand three times (neuPrint's client, this one, and `transport.ts`'s in-memory
variant), which is three statements of rules whose violation is invisible. What is shared is the
memory and the preference ordering; the *loop* stays with each caller, because what a status
means, which errors travel on the auth channel and what a failure should say are per-backend. The
three rules: only a *thrown* fetch moves on (a
response of any status means the request arrived), only a **2xx** is remembered (a 404 is what a
static host answers for a relay path nobody serves, and pinning that would outlive the day the
deployment gains CORS), and an `AbortError` is never answered by trying elsewhere. Direct is
first, because the hosted service needs no relay and asking for one would fail on a static
deploy. The relay is `/st/<encoded-origin>/<path>`, served by the **same** `vite.config.ts`
plugin `/np/` uses — one handler, because the SSRF guard is the part that must not be copied.

**The relay is a development answer, not a fix.** A static deploy serves nothing at that path,
so the published build cannot reach FlyTable until the deployment sends the headers.
`docs/flytable-cors.md` is the nginx config, and the four things in it each fail silently on
their own — the preflight answered before authentication (a browser sends `OPTIONS` with no
`Authorization`, which is why it reaches Django and 403s), `Authorization` in the allow list,
`always` so the headers survive a 401 (without which `reportAuthFailure` cannot read the status
and a rejected token reads as an unreachable host), and per-`location` repetition, since
`add_header` does not inherit into a block that has one of its own.

**Two things about that config were got wrong first, and both are worth knowing before touching
another deployment.** `/dtable-server/` and `/dtable-db/` **already send their own CORS
headers**, so adding a second is not belt-and-braces — two `Access-Control-Allow-Origin` headers
on one response make a browser reject it, which would break the half that works. And the
endpoint SeaTable's own documentation points a browser at, `/api/v2.1/dtable/app-access-token/`,
is not the one Coda calls: it takes a token minted **for one base** and answers an account token
`403 Permission denied`. So the two locations that need opening are `= /api/v2.1/workspaces/`
and an anchored regex for `/api/v2.1/workspace/{ws}/dtable/{base}/access-token/` — pinned rather
than a `/api/` prefix, which would expose the whole of seahub's v2.1 API.

**The `*` is load-bearing and must not become an echoed origin.** These endpoints also accept a
Django session cookie, and a literal `*` makes a browser refuse to attach cookies at all — so
the cookie path is structurally unavailable rather than merely unused, and only the
`Authorization: Token …` flow works. An echoed origin plus `Allow-Credentials` would let any
permitted origin mint tokens for a logged-in user, and `SameSite=Lax` is no backstop on this
host: `ac.uk` is a public suffix, so every `*.cam.ac.uk` server counts as same-site.

Verified in a real browser over CDP against `pnpm dev`, which is the only thing that could:
direct throws `TypeError: Failed to fetch`, the relay returns the data, `cloud.seatable.io`
direct answers without one, and the full client path — `listBases` 46 bases and `readMetadata`
through the `/dtable-server/` prefix — works with the route remembered as `proxy`.

### The CAVE table provider, and where its line falls

It reads a table carrying a root id **directly**, wide or long — `pivotOn` turns a
one-row-per-(neuron, kind, value) table into columns, reusing the per-kind split `CaveSource`
already needed for the 500,000-row cap. FlyWire's `hierarchical_neuron_annotations` is *not* such
a table: it is keyed by `target_id` into `proofread_neurons`, so reading it needs a join only the
datastack's own spec knows how to write. That stays in `CaveSource` as the built-in, which is
what a dataset uses when nothing is wired — and keeping it there is what lets this provider be
about *tables* rather than about FlyWire.

**`peekColumns` is synchronous and answers `undefined` until it knows**, the same contract
`schemasFor` has and for the same reason. A wide table answers immediately from the ref; a long
one has to ask the server what its kinds are, and does it once per ref through the 52 kB
`unique_string_values` call. `reportAnnotationsLearned` is the third thing wired to
`afterSourceLearned` — dataset listings, upload schemas, and now these: three asynchronous facts
that inference reads synchronously, one handler.

### Backends, told apart

`BACKENDS` in `datasetFamilies.ts` — a table, because "which backend" is now three things a
reader needs and a fourth backend should be one entry rather than four edits.

- **The backend is in the name**: `MaleCNS (neuPrint)`, `FlyWire FAFB (CAVE)`. Not decoration —
  one dataset can be published on more than one backend, and without the suffix two nodes in the
  Add menu would read identically and behave differently. A backend with an empty label adds
  nothing, which is what keeps `Hemibrain (mini)` from becoming `Hemibrain (mini) (Mock)`. **The
  node type ids are untouched**: that is what a saved graph carries.
- **The card is tinted by backend**, through `--cat-dataset-<id>`. A *lightness* step within the
  one green, not a second hue: deuteranopia and protanopia collapse red-green hue differences and
  leave lightness intact, so two greens a stop apart separate for every reader while a green and
  a teal separate for only some — and the category palette was validated as a set, so a genuinely
  new hue would mean re-running the validator against the sockets too. The step is deliberately
  large; a small one reads as a rendering artefact.
- **The browser tile carries a pip**, which is the non-colour channel. A grid shows dozens of
  tiles at once and two greens are a weaker signal at that size than on a card. One lit pip in a
  fixed slot, so it is positional rather than a count to read.
- **`Custom CAVE`** joins `Custom neuPrint`, and needs more than it: a datastack has no
  privileged table, so the node names its neuron table and registers a spec through
  `registerDatastackSpec` — synchronously and with no network, `neuPrintSourceFor`'s rule.

  **Its Materialization is a dropdown fed by a per-datastack peek**, not by the listing. That is
  forced rather than chosen: `listDatasets` lists only datastacks with a spec in the *static*
  table, so a datastack somebody has just typed is not in it and never will be.
  `peekMaterializations` is `schemasFor`'s contract again — synchronous, `undefined` until it
  knows, starts the fetch once per datastack and re-infers through `reportSourceLearned` — with
  `materializationsFor` as its awaited half, which `evaluate` uses. One memo behind both, so the
  materialization the dropdown *shows* and the one a run *uses* cannot disagree.

  Three things about it, each of which is a state somebody actually sees. **The empty select is
  said in words**: `Name a datastack first` before one is typed, because a dropdown with nothing
  in it reads as a broken control. **A pinned value is kept as an option while the list is
  unknown** — the family nodes need no such thing, since their listing is one call every dataset
  node shares, where this one is per-datastack and so absent on *every* reload; without it a
  pinned materialization blanks for a second and reads as forgotten. And **`evaluate` resolves
  "latest" by fetching rather than by peeking**, or an unpinned node fails on the first press and
  works on the second — the runs-twice-answers-differently signature this codebase keeps being
  caught by. `dataset.test.ts` pins all three, and the last two were confirmed by mutation.

  The `validate` order matters too: the shipped-datastack collision is checked **first**, because
  `specFor` prefers the static table, so every other setting on the card is inert for a datastack
  that already has a node — and asking for a neuron table first answers a question that does not
  matter.

**The Annotations socket takes an ordinary table, and used to be its own type.** It had the
dataset hue and the `diamond` shape and described the contract exactly — and that is what made it
wrong. An annotation base is somebody's spreadsheet: it routinely wants a row dropped or sixty
columns narrowed to four *before* a connectome is labelled by it, and a bespoke socket type meant
no table op could touch one. `FlyTable → Filter → Sort → Dataset` is now an ordinary wire, and so
is `Upload Table → Dataset` for a lab's own cell typing, which was impossible outright. The socket
takes the table hue, which is honest.

**`T.table()` and not `T.neurons()`, though every source does guarantee a `neuronId`.** Filter,
Sort, Sample, Stack and `out.table` all *preserve* neurons-ness — checked, and each says so — so
the stricter socket accepts every op somebody names first and then refuses `core.select`, which
publishes a plain `table` because a selection *may* drop the id. Narrowing sixty columns to four
is as ordinary a clean-up as dropping a row, so that is the case the type has to admit. "Has this
column" is not a question assignability answers here; `types.ts` says so outright, and the
requirement moved to `validate`, where it can name the column. `annotations.test.ts` pins the
Select case specifically, because the Filter case passes under *either* socket type — a test
built on it would have looked like it was defending the choice while defending nothing.

**And `validate` only warns, so `annotationsFrom` refuses at run time as well.** The two things a
run could do instead are both silent: ignoring the wire is the control that quietly does nothing,
and carrying it on leaves `withAnnotations` merging a schema with no id column, so every neuron
comes back unlabelled with the connectome to blame. One funnel, so the two dataset nodes cannot
disagree about which.

**What identifies an annotation table is now provenance, not the refs that fetched it.**
`AnnotationsValue` was `{kind, sources, table}` and is now `DatasetAnnotations` — `{key, table}`,
a field of `DatasetValue` rather than a member of the `Value` union. `sources` was the chain's
`refKey`s, and the moment a Filter is allowed to stand in the chain those stop describing the
table: two graphs filtering one base differently would share a cached neuron index, and the first
one fetched would win for the session — precisely the failure the chain key was added to prevent.
So the dataset node pairs the table with **`ctx.inputKey('annotations')`**, the scheduler's own
`hash(type, params, upstream)` for whatever arrived on that port. It keys the CAVE neuron index,
the Explore widget's shared entry and the profile cache, exactly as `chainKey` did.

**`ctx.inputKey(portId)` is new on `EvalContext`**, and the scheduler was already computing it —
`desiredKeys` builds `${key}:${handle}` per port to fold into the hash, and `upstreamKey` is now
that one spelling shared by both. Deliberately *per port* rather than the node's own key, which
would fold in params of this node that say nothing about the value on that port.

It also closed a latent bug rather than only enabling the feature. `refKey` is `provider:config`
and `refresh` is in neither `seaRef` nor `caveRef`, so bumping an annotation node's Refresh
re-downloaded the base and re-ran the dataset — and then `neuronIndex` hit the same `chainKey`
with the same column fingerprint and served the stale index. Traced rather than reproduced;
provenance keying makes it structurally impossible.

**Connections gained a fourth section rather than two more source tabs.** The top level there is
*what kind of connection*, and an annotation base is somebody's spreadsheet of labels joined onto
a connectome — filing FlyTable under Data sources would say it was a fourth backend you could
query for neurons. Same split, same reasoning, as the AI key.

### Root ids drift, and the dataset says so

A CAVE root id is retired by any proofreading edit that touches its segment, so an annotation
base — somebody's spreadsheet, edited on its own schedule — drifts out of step with a **pinned**
materialization on its own. Nothing fails when it does: the labels stop matching, those rows join
to nothing, and the dataset reads as under-annotated. `data/cave/rootIds.ts` is the heads-up.

`caveclient.chunkedgraph.is_latest_roots`, read off caveclient 8.2.1 rather than recalled:
`POST {cg}/segmentation/api/v1/table/{table}/is_latest_roots?timestamp=<epoch seconds>` with
`{"node_ids": […]}` → `{"is_latest": […]}`. The timestamp is the materialization's own
`time_stamp`, which `versionsMetadata` already returns and `datastack.ts` was throwing away — so
it costs no extra round trip.

**It is fired and forgotten.** `evaluate` starts it and returns; the answer lands on
`subscribeRootCheck`, the **fourth** thing wired to `afterSourceLearned`, and `validate` reads it.
So a run is never delayed by it and never fails because of it, which is right for an advisory
about data the node did not fetch — and it is a *warning*, since an id that moved on is a fact
about somebody's base rather than a mistake in this graph.

**Four things keep it off the service**, which matters because this is a shared production
chunkedgraph at roughly 50–100 µs a root:

- **Once per (dataset, chain).** The ids arrive on every run, so re-asking per run is the
  hammering to avoid — and never re-asking at all leaves the answer describing a wiring that is no
  longer on the canvas, which is the bug below.
- **Cached per (segmentation, frozen timestamp), permanently.** Whether a root was current at a
  past instant *never changes*, so the answer is good forever — no expiry is passed to `cacheGet`
  at all. Keyed on the segmentation and the instant rather than on the dataset or the id list, so
  two datastack nodes share it and a base that gained rows costs only the rows it gained.
- **Only ids nobody has asked about**, which is what that key buys.
- **Deduplicated, and sequential in chunks of 10,000.** An annotation base repeats ids — 1,089 of
  them on FlyTable's `main.info`, one 104 times — and firing every chunk at once is the same
  hammering by another route.

**The body is written as text**, because `node_ids` is a list of integers on the wire and an
eighteen-digit root id through `JSON.stringify` of a `number` is a different neuron (invariant 8)
— while *quoting* them is a type this endpoint was never promised to accept. `cavePostRaw` exists
for that one case; every other CAVE POST goes through `cavePost`. The query endpoint's own
tolerance of quoted ids was established live and does **not** transfer to this one.

**And it answers to the wiring, which it did not at first.** The report was keyed on the dataset
id alone and taken *once per session*, so the check was never re-asked: dropping an `Update root
IDs` into the chain left the warning up, and pulling one back out never raised it. Both directions
reported, and each reads as the opposite feature being broken — the repair not working, or the
advisory not noticing.

The fix is that a report records **which chain it is about**, and the chain's name is
`ctx.inputKey('annotations')` — the same provenance key the dataset node already pairs with the
table, which changes exactly when the table would (invariant 4). Four rules fall out, and each was
mutation-checked because every one of them fails as a *plausible* warning rather than as an error:

- **A new key drops the old answer immediately**, before the replacement lands. It was about a
  chain that is no longer there, and a warning that outlives the repair it asked for is the
  original bug wearing a shorter timeout.
- **The drop is announced on `subscribeRootCheck`.** A run does not re-infer, so nothing else
  would re-run `validate` — the warning would sit on the card until an unrelated edit, which is
  precisely what "it didn't work" looked like.
- **Nothing wired is a real key**, not a reason to keep the last one. Otherwise unplugging the
  annotations leaves a warning naming ids the graph no longer holds.
- **A late lander does not overwrite a newer chain.** The repaired ids are the ones the permanent
  cache already knows, so the *replacement* check routinely finishes first and the superseded one
  arrives after it — restoring the warning somebody just cleared, permanently.

A failure releases the claim so the next run asks again, where a settled "nothing to say" — no
chunkedgraph, no timestamp — keeps it: a dropped connection is not an answer, and a datastack with
no chunkedgraph will never have one.

The known limit, stated on `rootDriftIssues`: the report is keyed on the **dataset id**, which is
all `validate` can see (an `InferContext` carries params, types and nothing else), so two dataset
nodes on one datastack and materialization with different annotation chains share one entry and
whichever ran last owns it. Uncommon, and the message says what was checked rather than whose it
was.

### Update root IDs: the repair

`cave.updateRootIds`, `Add ▸ Transform ▸ Update root IDs`. The drift check above says an
annotation base has fallen behind a materialization; this brings it forward, and the warning names
it so somebody reading one arrives at the other.

**A supervoxel is what makes a repair possible at all.** It is the atom of the segmentation —
proofreading regroups supervoxels, it does not split them — so a supervoxel id is the stable
handle a root id is not, and `get_roots(sv, timestamp)` answers which segment it belonged to at
any past instant. A row without one is left alone: there is nothing to recover from, and a stale
id is a better answer than a null or a dropped row.

**The staleness check runs first, and that is the whole cost control.** Only rows whose root is
*not* current are looked up, so an unedited base costs one `is_latest_roots` pass and **no**
`get_roots` at all. Both answers are cached permanently and keyed on (segmentation, frozen
timestamp), for the reason the advisory's are: what a root or a supervoxel was at a *past* instant
never changes.

**`roots_binary` is the one CAVE endpoint here that is not JSON**, and for once that makes
invariant 8 easy: raw `uint64` in and out, so a `BigUint64Array` carries an eighteen-digit id
exactly with nothing parsed, rounded or quoted. `cavePostBinary` exists for it — its own function
rather than an option on `request`, which parses JSON unconditionally.

**The id column keeps its storage.** A CAVE id column is `str` and stays text; a table holding
them as numbers keeps doing so rather than changing dtype under every picker downstream, and
`idText` refuses a number too wide to be exact so nothing silently rounds.

The guard in the rewrite loop — only touch a row whose id was *stale* — reads as redundant, since
only stale rows are ever asked about. It stops being redundant the moment the cache is warm: the
supervoxel map is permanent and shared across runs and datasets, so a later run can hold a root
for a row that did not move, and without the guard that row is silently rewritten. Pinned by a
test that seeds the cache, after a mutation showed the obvious test could not see it.

Its Dataset input is a **reference** — see the reference-edges section — which is what lets it sit
between an annotation source and the dataset it feeds. That wiring was a cycle until references
existed, and it is the placement the node is for.

Not exported: named in both `NO_EMITTER`s, since it is caveclient's chunkedgraph and only ever
sits on a CAVE dataset, whose own node is excused for the same reason.

### What is not done

The **R** exporter emits none of it — `dataset.flywire`, `dataset.cave` and the three annotation
nodes are named in its `NO_EMITTER`, and a CAVE graph is refused outright there. Python emits all
six; see *The CAVE half of the notebook exporter* below for what it does and does not reach.

A node body for the annotation sources — a base and table picker fed by `listBases`/`readMetadata`
rather than two text fields — is the obvious next thing; the client methods it needs already exist
and are what the Connections tab's Test button uses.

Not looked at in a browser: the tints, the tile pips and the chain on a real canvas. Same
standing as the WebGL viewers.

## Two caches, and the two controls that clear them

`Invalidate Results` and `Clear Cache`, in the node's context menu and side by side in the
inspector. They are different layers and the difference is not cosmetic:

| | what it holds | keyed by | cleared by |
| --- | --- | --- | --- |
| the scheduler's result cache | what `evaluate` returned | provenance — `hash(type, params, upstream)` | Invalidate Results |
| the data cache (`loadCachedTable` → IndexedDB) | what a *server* returned | what was fetched | Clear Cache |

**Only the first was reachable, and the menu claimed otherwise.** The item read `Invalidate
cache` with a tooltip saying "forcing a re-fetch" — and on a FlyTable node the card cleared, the
node re-ran, and the answer came back in milliseconds with the same 79 MB of rows, because the
second layer is keyed by the ref and kept for a month. A control that looks like it worked.

**`ctx.refresh` is what crosses the gap.** `Scheduler.clearNodeCache` invalidates the result *and*
arms a flag; `evaluate` reads it and passes it down to whatever fetches. Session state, never the
document — it must not be saved, must not travel to whoever you send the file to, and must not
take part in the provenance key.

Two things about *when* it is spent. It goes at **execution**, not at the top of a run: an
expensive node is deferred by the cheap pass, which fires on every keystroke, so a flag cleared
there would be gone before the node ever had its chance — Clear Cache would work or not depending
on whether anybody typed in between. And `pruneCache` drops it with its node, since ids are reused
across loads and a stranded request would be spent by whatever took the id.

**`NodeDefinition.dataCache` is one declaration meaning two things**: the button appears, and
`evaluate` honours `ctx.refresh`. Paired deliberately — a node offering the button and ignoring
the flag is exactly the control-that-does-nothing this replaced, and a button on a Filter would
promise a re-fetch with no fetch behind it.

**The card says how old the data is, and the label is the control.** `cached 3d ago ⟳` in the
foot of any node that reported a fetch, clearing that node's data cache and running it. A passive
badge would leave the obvious next act — a fresher copy — two gestures away in a menu, and what
somebody wants on reading "3d" is not to be told again.

**Shown whenever there is an age, not only when it is large.** `cached 0s ago` is exactly as
informative as it sounds, and it is what makes the number believable the day it reads `28d` — the
rule that keeps geometry units printed when they are the expected ones, and the matched half of
`unmatchedLabels` on screen. There is no threshold and no confirm.

**The age is reported, not derived, and that is forced.** A cache hit and a fresh read are
indistinguishable from the rows, so `ctx.reportFetched(at)` carries it: `cacheGetEntry` hands
`savedAt` to `loadCachedTable`, which calls `spec.onFetched` — the `onProgress` idiom, because
every caller wants the table and only one wants the age, so widening the return type would edit
six call sites to serve one. The oldest report of a run wins, so a node making several fetches
says how stale its worst is.

**It lives in the scheduler's `CacheEntry`, not in `NodeRunInfo`**, and that is the whole of why
it works. A second Run over an unchanged graph re-executes nothing, so a run-time report would be
gone while the stale table it described stayed on screen — the failure CLAUDE.md already records
as "there is no channel from `evaluate` to a badge that survives a result being restored from
cache". This is that channel, and it took a second consumer to justify it: an age is the one thing
that genuinely cannot be derived from the result, since it is not in the rows.

`formatAge` is deliberately **not** `formatDuration`. That one measures how long a run took and is
written for the millisecond end (`<1ms`, `142ms`, `2.4s`); this answers a different question and
rounds rather than refining — nobody deciding whether to re-read a base is served by `2.7d`. It
**floors**, so nothing is ever reported as older than it is: `23h` stays `23h` until it really is
a day.

**It replaced the annotation nodes' `refresh` nonce.** A nonce works, and invariant 4 is why they
exist at all; what it costs is that re-fetching becomes an **edit** — in the provenance key, in the
saved file, and carried to whoever you send the graph to — and that every node wanting the ability
grows its own param. `dataset.*` and `core.tableFromUrl` still carry theirs; they are the obvious
next candidates, and `refreshParam` stays for them.

## Auto-run

A checkbox beside Run. On, every change re-runs the **whole** graph, expensive nodes included;
off (the default), the existing hybrid model applies. Persisted in `localStorage`
(`coda.autorun.v1`), so an expensive workflow can be left on manual.

**Off is a safety default, not a taste one.** Expensive nodes hit a shared production Neo4j, and
invariant 6 exists precisely so a reactive editor does not fire a query per keystroke. Auto-run
is an explicit opt-out of that.

**One timer, not two.** With auto-run on, `afterGraphChange` schedules _only_ the full pass, at
`AUTO_FULL_RUN_DELAY_MS` (700ms, against 180ms for the cheap pass). Scheduling the cheap pass as
well would have it supersede an in-flight full run — `scheduler.run` aborts whatever is running —
so a slow query would be cancelled and restarted by the very keystroke meant to refine it. The
cost is that cheap edits also wait 700ms while auto-run is on; the alternative is thrashing.

**`runFull` carries a token, and that is load-bearing.** `scheduler.run` supersedes an in-flight
run by aborting it, so the superseded call's `finally` lands _after_ the newer one has set
`busy: true`. Clearing `busy` there leaves the UI idle-looking — no Cancel button, an enabled Run
— with a run still going. Only the newest token writes `busy` or `lastRun`. This also fixes the
same latent race in a fast double-click on Run, which predates auto-run.

Switching it on runs immediately rather than waiting for the next edit: a stale graph that stays
stale until you touch something reads as the setting not working.

Testing note: the Filter node is `cheap`, so editing it proves nothing about auto-run — the
ordinary pass re-runs it either way. Only an expensive node's param distinguishes the modes.
And a `typePattern` matching nothing makes Connectivity error ("No neuronIds…") and blocks
everything downstream, so a test that waits for zero stale nodes will hang on it.

## Framing a graph that was just opened

`loadGraph` bumps `fitRequest`; the canvas catches it and calls `fitView`. Everything that opens
a graph — the toolbar's Open and New, the start page, the palette — routes through `loadGraph`,
so one signal covers all of them. It crosses as a counter with a mount-seeded guard because the
viewport belongs to React Flow and every trigger sits outside its provider, same idiom as
`paletteRequest` and `browserRequest`.

**The fit waits for `nodesInitialized`, and that is the load-bearing part.** `fitView` reads each
node's _measured_ size, and a node committed in this render has none — fitting immediately frames
a set of zero-sized boxes and lands at an arbitrary zoom. The hook goes false while the new cards
are unmeasured and true once React Flow's ResizeObserver has them, so the effect leaves the
request unhandled until then. Late and correct beats immediate and wrong.

**A graph with no nodes raises no request at all.** A request nothing can satisfy would sit
pending and be spent on whatever the user added next — a viewport that lurches minutes later,
nowhere near its cause. That is why `newGraph` does not ask and `loadGraph` checks first.

jsdom does no layout, so the canvas half has no test; `store/fitOnLoad.test.ts` covers which
loads ask and which do not.

## Automatic layout

Three buttons in the canvas controls rail, beside Zoom In / Zoom Out / Fit View
(`ui/panels/LayoutControls.tsx`): **arrange**, **auto-layout**, and an **options** bubble.
ELK Layered via `elkjs`. The headless half is `src/layout/`; only the buttons and the pass
driver (`ui/useArrange.ts`) are React.

**`src/layout` is a top-level sibling of `core`/`data`/`nodes`, and that placement is load-bearing.**
The store holds the layout preferences, so `store/persistence.ts` needs `LayoutOptions` — and
putting the module under `src/ui` would make the store import the UI, which is both a new
dependency direction and a cycle, since the UI imports the store. Nothing in `src/layout`
touches React.

**Only the canvas knows how big a card is.** A node's height comes from its param rows, its port
count, its body widget and whether it is collapsed — none of which the document records. So
`resolveSize` prefers the canvas's measurement and falls back `node.size → defaultSize → 232×120`.
A zero measurement counts as no measurement: a card mounted but not yet laid out reports 0×0, and
taking that literally arranges a tidy grid of points.

**Sizes are read from `offsetWidth`/`offsetHeight`, and both plausible alternatives are wrong
here.** This cost a real bug — every card silently taking the 232×120 fallback, so ELK arranged a
row of identical boxes and packed each wide card's neighbours straight through it. Explore is 520
across, a dataset card 248, a Profile 560.

- `getNodes()` is `store.nodes.map((n) => ({ ...n }))` — a shallow copy of the array _the editor
  built_. In controlled mode `measured` on it is whatever we put there, which is nothing.
- `getInternalNode(id).measured` is the real measurement, but React Flow's `adoptUserNodes` only
  carries it forward while the _user_ node object behind it is identity-equal, and otherwise
  re-seeds it from `userNode.measured`. `rfNodes` rebuilds every node object on each store change
  and `onNodesChange` deliberately does not persist React Flow's own dimension measurements into
  the document — so **every graph edit wipes every measurement**, and the ResizeObserver does not
  re-fire for a card whose size did not change. Observed live: 9 measured, then 0, then 0.
- `offsetWidth`/`offsetHeight` are layout-space and ignore CSS transforms, so they are the card's
  size in flow units at any zoom. Verified at zoom 1.0, 0.833 and 0.694, where an Explore card's
  bounding rect reads 520, 433 and 361 while its offset size reads 520 throughout.

Zoom-independence is not a nicety: these numbers go into `structureKey`, and a size that drifted
with the viewport would have auto-layout re-arranging the graph every time somebody scrolled.

**`useNodesInitialized` is unreliable in this app, for the same reason.** Its store flag is
computed inside `adoptUserNodes` from the internal node's `measured`, which the paragraph above
wipes on every edit — so it latches **false** once the first edit lands, and never recovers.
Auto-layout was gated on it and consequently never ran at all. It now asks the readiness question
of the sizes it is about to use instead. Worth knowing that the _fit-on-load_ path is gated on
the same flag.

**ELK numbers ports clockwise from the node's top-left.** With no north or south ports that walk
is every east port top to bottom, then every west port **bottom to top** — so an output's index
follows declaration order and an input's is the reverse of it, offset past the outputs
(`portIndices`). Backwards, this mirrors every card's sockets against the wires arriving at
them: nothing throws, nothing fails a type check, and the layout merely crosses more than it
needs to. `layout.test.ts` checks the convention against the real algorithm rather than against
the comment describing it.

**Port constraints depend on direction, and the number is measured.** Horizontal directions get
`FIXED_ORDER`; vertical ones get `FREE`. Under `DOWN`, pinning the sockets east and west makes
ELK reserve routing space for a wire leaving a card's right edge and re-entering the left edge of
the one below, and a four-node chain comes out as a **diagonal staircase**: x-spread 756 under
`FIXED_ORDER` or `FIXED_SIDE`, 39 under `FREE`, with the same 648 of vertical travel either way.
Nothing is lost by freeing them — ELK's port coordinates are discarded regardless and React Flow
draws each wire from the real socket.

**A wrong ELK option key is silent.** ELK ignores an option it does not recognise instead of
rejecting it, so a typo in one of those strings survives typecheck, lint and the eye. That is why
`layout.test.ts` runs the real algorithm and asserts on the _result_ — direction, spacing, port
order — rather than on the record being built.

**Edges reference port ids, not node ids** (`elkPortId`, `nodeId#portId`), which is what makes
`FIXED_ORDER` mean anything. Deliberately not `core/graph`'s `portKey`, which joins with a NUL
byte: fine as a Map key inside one process, a bad thing to send through `postMessage` into a
GWT-compiled Java port that builds strings out of it.

**elkjs never enters the main chunk.** Same doctrine as three.js and sigma. In the browser it
runs in a **worker** — auto-layout mode re-arranges on every structural edit, so the pass is not
something the canvas can afford to block on. Under vitest there is no `Worker`, so the bundled
build stands in, which is what lets the tests put the real algorithm behind the real mapping.
That fallback's specifier goes through a variable and `@vite-ignore`: written as a literal,
rollup resolves it and emits the whole 1.4 MB bundled build into `dist/` as a file no browser can
ever fetch. Verify with `pnpm build` — `elk-worker.min-*.js` should be its own chunk and
`elk.bundled-*.js` should not exist at all.

**The result is anchored, then dodged.** ELK lays out from the origin, so `anchorTo` puts the
block's top-left back where the arranged set's top-left already was — otherwise arranging a graph
on a canvas panned away from (0,0) teleports it off screen, which reads as having deleted it.
Then `dodge` shifts it clear of the text notes.

**Notes never move; the pipeline gives way.** A note is somebody's sentence about a particular
step. `dodge` resolves against each note _in turn_ rather than against one union rectangle: an
example with a note above the chain and another below has a union spanning the whole canvas, and
clearing that would fling the graph hundreds of units down past empty space it never touched.
Downwards only, because the flow is horizontal and the examples place their notes by column — a
sideways shift would slide every note out from over the step it describes.

Note the consequence, which was accepted rather than overlooked: arranging a bundled example
moves the pipeline but not its commentary, so a note written for one step can end up above a
different one. And `dataset.description` is **not** an annotation — it has a Dataset input and
takes an ordinary pipeline slot, which is the position `core/companion.ts` deliberately avoids
when it places one by hand.

**Auto mode watches `structureKey`, not the graph.** Node identity, type, collapse and _measured_
size, plus every edge's four endpoints. Positions are out, so a drag never asks for a new
arrangement. Params are out too — but a param edit that changes a card's height still triggers,
because it reaches the key through the measurement. That is "structural changes only" arrived at
through what is on screen rather than through a hand-kept list of which params are allowed to
matter.

**`arrangeNodes` exists so the layout does not switch itself off.** A committing `moveNodes`
frame clears `autoLayout` — a position somebody chose outranks one ELK computed, and a card that
springs back from where you just put it is not a setting working, it is the editor refusing to be
edited. Sent down that same path, an arrange would clear the flag every time it ran, so
auto-layout would work exactly once. Opening a graph clears it for the same reason: the positions
in a file are somebody's decision.

**Animation frames never reach the store.** `commit` re-runs `inferGraph` and `refreshStates` on
every call, and an eighteen-frame glide has no business paying for eighteen inference passes to
move some rectangles. The frames live in `EditorCanvas` state and override `position` inside the
existing `rfNodes` memo; one `arrangeNodes` lands at the end, so the whole arrangement is a single
undo step. The commit and the override-clear happen together, because clearing first flashes the
old positions for a frame. `prefers-reduced-motion` skips to the commit.

**The auto effect retries rather than giving up.** It runs when the graph commits, which for an
added node is before the browser has laid its card out — so the newcomer has no size yet and
would be arranged around a fallback box. Nothing else re-runs the effect: its deps are the graph
and the mode, and a card being laid out changes neither. So it re-checks on the next animation
frame, bounded, and then proceeds anyway.

The other half of that bug was cancelling the pending arrange at the top of the effect and
rescheduling below: the pass that re-ran after measurement found the key unchanged and returned,
having already cancelled the arrange the previous pass scheduled _and_ advanced `lastKey`, so
nothing ever rescheduled it. A node added with auto-layout on simply stayed where the palette
dropped it, on top of whatever was underneath. The early return must leave the timer alone.

**Both size bugs above were found in a real browser, not in the suite,** and that is the standing
lesson: jsdom reports one stubbed size for every element, so a layout built from measurements and
one built from the fallback both look plausible there. The suite now pins the difference —
`layoutControls.test.tsx` asserts that no two arranged cards overlap _at their measured size_,
which fails with 15 collisions against the old code — but the sizes themselves were only ever
distinguishable against a laid-out page.

The _worker wrapper_ remains uncovered: jsdom has no `Worker`, so tests take the bundled path.
What was checked by hand is that `elk-worker.min.js` guards both its entry branches with `typeof`
and calls no `importScripts`, so vite serving it as a module worker in dev is safe.

### Edge routing — wires that go around the cards

A fourth button on the controls rail, between auto-layout and the options bubble, toggling
**Curved ↔ Orthogonal** (`EdgeRouting` in `layout/options.ts`). Per-user in `localStorage` under
the layout key, never in the document — a file you were sent must not restyle itself to somebody
else's taste.

**ELK has been computing these routes all along and they were being thrown away.** `runLayout`
called `positionsFrom(laid)`, which reads `result.children`; the bend points are in
`result.edges[].sections[].bendPoints` and were never read. `elk.edgeRouting` is still **never
set** and should not be: layered produces orthogonal bend points regardless, and the two settings
that would change them move the *nodes* as well — `POLYLINE` shifts every position and yields
fractional x, `SPLINES` returns a variable-length control-point list that is a different
rendering problem. So the layout half of this feature costs one extra function, `routesFrom`.

**Sockets are pinned into ELK, and that is what makes a route usable.** A Coda card pairs input
*i* and output *i* into one `.port-row`, so opposite sockets share a height; ELK spreads ports by
its own `spacing.portPort` rule and has no constraint that can say otherwise. Handing it the
measured offsets (`MeasuredPorts`, `FIXED_POS`) settles it at the layout end rather than by
splicing real endpoints onto a computed middle. Measured: `FIXED_POS` honoured every offset
exactly, still bent the edges that had to clear a card, and left node placement unchanged in x
and *tidier* in y — row spread 0 against 9.5.

Three things about that measurement, each of which was wrong first:

- **Bounding rects, not `offsetTop`** — the reverse of the rule `measure()` follows for sizes,
  and principled: a handle is positioned `top: 50%` and centred by a `transform`, so the offset
  correction differs by side (`translate(-50%)` left against `translate(50%)` right) and the
  diamond sockets add a `rotate`. A rect has applied all three, and dividing the card-relative
  difference by the zoom cancels the camera exactly.
- **React Flow's `handleBounds` is unusable**, for the reason `measure()` cannot use
  `node.measured`: `parseHandles` returns `!userNode.measured ? undefined : …` and this app never
  writes `measured` back, so `adoptUserNodes` wipes handle bounds on **every graph edit** and
  React Flow re-measures asynchronously afterwards.
- **A card is pinned only when every one of its sockets was measured, and only under a
  horizontal direction.** `FIXED_POS` takes coordinates literally, so one unmeasured port lands
  at (0,0) — the card's corner, on the wrong side — and ELK routes confidently into it. And ELK
  honours explicit port positions under `FREE` too, so supplying them under `DOWN` reinstates
  exactly the constraint that direction had lifted: the diagonal staircase came back at x-spread
  319 against 39, with the option string still plainly reading `FREE`. Sockets that all resolve
  to *one point* are also rejected — a real card never stacks them, so exact agreement means the
  rects were not describing a card, which is what a jsdom stub produces.

**Routes take the same anchor and dodge the positions take**, read back through `anchorDelta` /
`dodgeDelta` rather than re-derived. ELK lays out from the origin, so a route left there is not
subtly wrong — it is a wire drawn the whole width of the graph away from the nodes it joins.
They are **not rounded**, unlike positions: a route is never serialised, and a socket sits at its
card's rounded position plus a *fractional* offset, so a rounded waypoint disagrees by that
fraction and the wire leaves at an angle. Measured at 0.39 units before the rounding came out.
A residual of up to half a unit survives because the nodes round independently at each end;
`CodaEdge` anchors the path on React Flow's sockets and lets only the middle be ELK's, so a wire
is attached whatever the waypoints say.

**Routes are held against `routeKey` and dropped the moment it stops matching.** That is
`structureKey` plus every node's position, and the difference is the point: positions are outside
`structureKey` on purpose, so a drag does not ask for a new arrangement — but a route is a path
through particular gaps, so one card moving leaves the waypoints describing a picture that is not
there. Nothing re-routes on a drag; that is an ELK pass per pointer move. Same idiom as
`ui/viewers/layoutMemo.ts`, and for the same reason: there is no single event meaning "the
arrangement is stale", only many that are.

**A third mode was built and removed, and that is the most useful thing recorded here.**
`routed` kept the bezier everywhere *except* on wires ELK had actually bent — a smaller change
that leaves the canvas in its own visual language and touches only the wires that needed it. It
reads well on paper. In the hand it did nothing: ELK produces bend points **only as a by-product
of laying a graph out**, so on a canvas nobody had arranged there were no routes and the mode was
byte-identical to `curved`. A button that does nothing until you press a *different* button
first, which is exactly how it was reported.

There is no fixing that inside ELK, and it was checked rather than assumed: `elk.fixed` honours
given positions and returns **zero** routes; `elk.fixed` plus `ORTHOGONAL` throws; and every
interactive layered strategy (`layering`, `crossingMinimization`, `cycleBreaking`,
`nodePlacement`) still moves every card. Routing wires around cards that are *already placed* is
an obstacle-routing problem ELK does not solve — it would be our own router, which is a real
project and a separate decision.

`orthogonal` has no such hole because it steps **every** wire: the ones ELK bent follow the gap it
reserved, and the rest take a plain step path. So the control always does something visible,
arranged or not. That is also the honest reading of the measurement — only 10 of 32 edges across
the bundled examples carry bend points at all, so a mode keyed *solely* to those was always going
to look like it had half worked.

Note what the routes are *worth*, measured in a browser across all five examples: as the examples
are hand-placed, 1–2 wires cross a card each; **arranging alone** clears every one of them in four
of the five, because ELK's placement already reserves the channels. Routing fixes the fifth. A
modest win on a tidy graph and a real one on a wide card or a long skip — which is the honest
reason `orthogonal` is offered as a *drawing style* rather than as a fix for crossings.

**`data-routed` on the path is for the tests, and it is not laziness.** Nothing about the path
shape distinguishes an ELK route from a computed step: measured, `getSmoothStepPath` emits between
0 and 4 corners depending only on where the sockets landed — no arrange gives `0,0,0,0,0,0,0`, an
arrange `2,4,2,0,0,0,0` and a drag `2,2,2,2,4,0,0`, a plain step path outscoring a routed one. The
only other discriminator is the punctuation the two generators happen to use, which would keep a
genuine regression green the day either changed a space. Both route tests in
`layoutControls.test.tsx` were verified by mutation — removing the staleness drop fails the drag
test, making it unconditional fails that one *and* the param one.

`CodaEdge` is the only registered `edgeTypes` entry and draws both. Registering it costs
nothing that was relied on: React Flow's `EdgeWrapper` renders the component *and*
`EdgeUpdateAnchors` as siblings inside a `<g>` carrying the click, right-click and focus
handlers, so the drag-off rewire, `reconnectRadius`, the edge menu, selection and Delete are
untouched — and `BaseEdge`'s `interactionWidth` copy follows the detour, so the hit target does
not stay on the straight line the wire no longer takes. Under `orthogonal` a wire with no route
falls to `getSmoothStepPath` rather than a fourth path builder, sharing `CORNER_RADIUS` so one
canvas has one kind of corner.

**No route reaches a wire under `curved`** — `Editor` withholds it rather than passing it with a
flag saying to ignore it. The mode is a fact about the canvas and the route a fact about one
wire; letting the component read both is how a wire ends up bent in the mode that says it is not.

Verified in a real browser as well as headlessly, because this is exactly the class jsdom cannot
see: both modes drawn, wires attaching to their sockets, corners filleting, a route going around
the card the curve went through, and no console errors. It is also how the retired mode's hole was
found — jsdom happily confirmed `routed` "worked", because every one of its tests arranged first.
What has **not** been looked at is a route under a non-default algorithm: `mrtree` bends every
edge, `force`/`stress` bend none and `radial` returns no `sections` at all, all of which read as
"no route" and are covered headlessly.

## The tutorial page

A second vite entry — `tutorial.html` at the root, `src/tutorial/{main.ts,tutorial.css}` — built
into `dist/` alongside the app and published to GitHub Pages with it. Ten chapters. The first six
share one pinned canvas that builds a real pipeline as you read — `Hemibrain → Find Neurons →
Connectivity → Filter → Group By → Bar Chart` — then Explore/Profile, neuPrint, the keyboard and
saving get their own set-pieces.

**It imports nothing from the app but `theme.css`, and that one import is the whole design.** The
page draws node cards, sockets, wires and a run ring in plain CSS rather than mounting React Flow —
so a tutorial about what a Dataset socket looks like cannot disagree with the editor about it, while
costing none of React, sigma or three. Verify with `pnpm build`: `tutorial-*.js` should stay around
4 kB and `dist/tutorial.html` should reference no `main-*` chunk. If it ever does, something reached
into `src/ui` beyond the stylesheet.

**Naming both entries in `build.rollupOptions.input` is what keeps it.** Vite otherwise treats
`index.html` as the only root and drops the second page silently — it builds green and 404s in
production.

**The palette is used semantically, never decoratively.** Green means Dataset, blue means
Table/Neurons, orange means Matrix/Network, on the page exactly as on the canvas — including inline
in running text (`.ty--dataset` and friends). That is the entire chromatic vocabulary; everything
else is the warm neutral the canvas already is. Chips go through `--chip-1..8` rather than literal
hex, so they re-resolve on a theme switch like the real ones.

**Hidden-until-scrolled states are gated on a `js` class the script claims on `<html>`, and the
script is wrapped in a try/catch that gives it back.** Found by running the page under jsdom, which
has no `matchMedia`: the script threw on line one, and because `.rise` carried `opacity: 0`
unconditionally, _every section of the page stayed invisible_. A static page is a fine failure; a
blank one is not.

**Chapter 3 is the one the camera cannot serve.** It is about the _execution model_, and Run,
Auto-run and the per-node ▶ are toolbar and header chrome rather than things in the world the
camera pans over. So that chapter dims the canvas and draws the toolbar cluster and a card header
large over it, with a pulsing ring on the two controls. The frame is deliberately identical to
chapter 2's, so the canvas does not move under the overlay.

**The camera is given a box to fit, never a zoom level.** `FRAMES` names a world rectangle per
chapter and `camera()` solves for scale, so the framing holds at any viewport instead of being
tuned against one. `FRAMES_NARROW` is a genuinely different composition rather than the same one
smaller — a phone stage is about a third of a desktop one, and the desktop frames put the card text
under legibility there, so the narrow set holds fewer cards each and the anatomy callouts stand
down. Chapter 6's wide shot is deliberately illegible: the cards are texture and the point is the
shape of the chain.

**Wire colours go through `style.stroke`, not `setAttribute('stroke', …)`.** A presentation
attribute does not resolve `var()`, so the wires come out black with nothing failing.

**Socket positions are walked through `offsetParent`, not measured.** The world carries a
`scale()`, so a bounding rect would be in screen pixels and would change with the camera;
`offsetLeft`/`offsetTop` stay in world units. Same distinction as the auto-layout note above, for
the same reason.

**The run ring is sized explicitly.** `inset: -6px` on an `<svg>` is over-constrained, so
`right`/`bottom` are dropped and it renders at its 300×150 intrinsic size — the same trap
`NodeRunRing.tsx` documents, hit again here.

**Sticky becomes block flow under 980px.** A sticky grid item can only stick within its own row, so
the stacked mobile layout would scroll the canvas away the moment the prose began.

Three entry points, all through `import.meta.env.BASE_URL` since `base` is `'./'`: the start page's
credits row, the toolbar's `? ▾`, and the README. Its outro links on to the node guide, which is the
reference half of the pair. **`Docs` on the welcome screen is this page**, not
the repository's `docs/` folder — that folder is written for someone extending Coda, and the link is
read by someone who has just opened it. `startPage.test.tsx` covers both in-app ones; a second vite
entry has no route for anything else to catch going missing.

The page itself has no test. jsdom does no layout, so the camera, the pinned stage and the wires
are exactly the class of thing it cannot see; what was checked by hand is that it runs clean under
jsdom across five viewport widths with every chapter resolving. Same standing as the WebGL viewers.

## The node guide

A **third** vite entry — `nodes.html` at the root, `src/nodeguide/{main.ts,data.ts,nodeguide.css}`
— and the reference half of a pair whose other half is the field guide. That one is read once,
front to back, and teaches the model; this one is come back to with a node in mind. Same
construction: plain TypeScript, no React, importing nothing from `src/ui` but `theme.css`.

A grid of every listable node grouped by where it sits in a pipeline, a search that dims
everything it does not match, and a detail pane that renders the node's paragraph, its sockets,
its settings and **the card it draws on the canvas**, built the way the editor builds one.

**Nothing on the page names a node.** Tiles, preview cards, socket shapes, settings, defaults,
category counts and the examples cross-reference are all read off the real `NodeDefinition`s. A
node added next month gets a correct entry without anybody opening `src/nodeguide`. The two
strings that are not derived are `description` and the new **`guide`** — two or three sentences,
required, and `nodeGuide.test.ts` fails a node that ships without one or whose `guide` merely
repeats its `description`.

### How a static page reads the registry, and why not the two obvious ways

**Importing `src/nodes` into the page costs 660 kB (211 kB gzipped)**, plus elkjs and the Draco
decoder, on a page whose whole point is that it is 5 kB. Measured, not estimated — the registry
drags in `src/core`, `src/data` and, through the neuroglancer node, a corner of `src/ui`.

**Committing a generated JSON** with a golden test to catch staleness — the idiom
`src/export/__fixtures__` already uses — works, and pays for a file in the repo that has to be
regenerated by hand and reviewed in every diff that touches a node definition.

So `vite/nodeGuideData.ts` loads it **at build time**: `ssrLoadModule('/src/nodeguide/data.ts')`
runs the extraction in Node through Vite's own TypeScript pipeline, and the result is inlined as
`virtual:node-guide-data`. ~250 ms, once per build. Nothing is committed and nothing can drift.

Dev and build take different servers, and that is not an oversight: `configureServer` hands over
the running one, so editing a node definition updates the guide on reload; a production build has
none, so one is created for the length of the call with `configFile: false` — loading this config
from inside itself would recurse. Nothing in `src/nodes` uses the `@` alias, which is checked and
is why `data.ts` imports by relative path. `handleHotUpdate` invalidates the virtual module on any
change under `src/nodes`, `src/core` or `src/examples`, or dev would keep serving whatever the
registry said when the page first loaded — the one failure that would make this worse than a
committed file.

Verify with `pnpm build`: `nodes-*.js` is ~86 kB of which ~80 kB is the inlined registry, so the
page's own logic is around 6 kB; `dist/nodes.html` must reference no `main-*` chunk.

### Smaller decisions, each of which was wrong first

- **`virtual.d.ts` types the module `unknown` and `main.ts` asserts.** A top-level `import type`
  makes that file a _module_, at which point `declare module` is read as an augmentation of a
  module that does not exist; an `import type` inside the block, and an inline
  `import('./data').GuideData`, leave the export `any` or trip `consistent-type-imports`. Nothing
  is lost, because `nodeGuide.test.ts` calls `guideData()` directly and checks the shape there.
- **Filtering dims in place and never removes a tile.** The grid is a map of the whole registry,
  so a search that reflowed it would throw away the one thing worth looking at — where in a
  pipeline the answer sits.
- **Example names are not in the search haystack, and that was measured.** One bundled example is
  called `LC → descending neuron matrix`, so including them had a search for `matrix` light every
  node in that graph — the dataset, Find Neurons, the bar chart — beside the five that genuinely
  carry one. An eight-node graph lends its title to all eight.
- **An enum's default prints its option's _label_.** The app's picker says `downstream (outputs)`
  where the stored value is `outputs`, and a guide naming the other one describes a control that
  is not on screen. Where `options` is a _function_ of the resolved input types (Filter's operator
  list is dtype-aware) there is no answer without a graph, so it says `depends on the input`
  rather than printing whichever option happens to be first.
- **`internal` params are dropped and `advanced` ones are kept.** A nonce or a pager is machinery
  a widget writes — the same exclusion the card's `… N more` counter makes. An advanced param is a
  real setting that happens to live in the inspector, and a guide is exactly where somebody finds
  out it exists. The preview card reproduces that split, so ROIs and Neuroglancer correctly draw
  with no param band at all and a `… 8 more` line.
- **Help text is a disclosure, not a second line.** Printing every `help` inline reads well on
  Filter and turns the Network viewer's pane into a wall of 33 settings. The dotted underline is
  what stops a row with help looking identical to one without.
- **The page does _not_ pin `data-theme="dark"`, unlike the field guide.** A reference kept open
  beside the editor is the wrong half of the pair to be stubborn about, so it follows
  `prefers-colour-scheme` exactly as the app does.
- **The preview's sockets are clipped, and that is faithful.** An expanded card on the real canvas
  clips its handles into half-discs against `.coda-node`'s `overflow: hidden`; only a _folded_ one
  shows them whole. The legend beside the pane draws whole pips, which is where the shapes are
  learned.

Four entry points, all through `import.meta.env.BASE_URL`: the toolbar's `? ▾` beside Field Guide,
the start page's credits row, the **node browser's footer** — the one surface where somebody is
already choosing a node and may not know what it does — and the README plus a link from the field
guide's outro. `startPage.test.tsx` and `nodeBrowser.test.tsx` cover the three in-app ones; a
third vite entry has no route for anything else to catch going missing.

The page itself has no test, on the tutorial's standing and for the same reason. What _was_ driven,
by playwright against the dev server: both themes at 1440px and a 420px phone stage, no console
errors, no sideways body scroll, the preview card correct for a 33-setting node and for a text
note, the help disclosure opening, and a search dimming 44 of 49 tiles without moving one.

### The inspector shows a table as text, not as a table

`.inspector__viewer` is **320 × 300** — the smallest surface a viewer is drawn on, smaller than a
card. It drew whatever the node's `pageSize` said, which on an annotation table is 100 rows across
60 columns: six thousand cells laid out per change of selection, of which about forty are visible,
behind a sideways scrollbar.

`ValuePreview.summary` replaces that with `TableSummary` — **one line per column, carrying its
name, its type and the first row's value**. The same information turned ninety degrees, and the
whole schema fits where three columns did. It is a *schema readout with an example* rather than a
sample of the data: what somebody selecting a node mid-pipeline wants to know is which columns
arrived and what a value looks like, and reading the table itself is the Table node's job and the
overlay's.

Deliberately **no `<table>`**: no intrinsic-width pass over every cell, no sticky header per
column, no horizontal scroll container — ordinary block layout in a narrow column, which is what a
narrow column is for.

Two intermediate versions are worth recording, because each was a smaller idea than the one that
worked. First a **row cap sized to the box** (25 rows, from 300px at ~19px a row). Then **one
row** — better, because the box was never the constraint, the panel's *job* was. Both were still a
table: the one-row version was reported back as *"the table still reads 1–1 of 58,340"*, which is
the point — a table shrunk is a table, and the panel was never the place for one.

Only the fallback table branch honours `summary`. A node with a viewer of its own — a scatter, a
heatmap, a profile — keeps it, since those already draw something sized to their box.

### The freeze was React's dev instrumentation, not the table

**React 19's dev build serialises changed props into Chrome's performance timeline, and does it
with `JSON.stringify` on primitive arrays with no length cap.** `logComponentRender` fires on every
render whose props differ from the previous one, deep-diffs old against new
(`addObjectDiffToProperties`), and for each changed key calls `addValueToProperties` **twice** —
once for the removed value and once for the added one. A Coda `TableValue` is an object of one
array per column, so handing one to a component costs a full JSON serialisation of the whole
table, twice, whenever its identity changes.

Measured on a real annotation base — 58,340 rows over 60 columns — that is **five seconds of CPU
and 1.5 GB of transient allocation** per selection, reclaimed over the following fifteen seconds.
It reads as the tab freezing. `addValueToProperties` (72.5%) and `logComponentRender` (21.8%) were
94% of a heap profile of it.

Three things about it are worth keeping, because each one sent the search somewhere else first:

- **It fires only where props *changed* on a component that stayed mounted.** Alternating between
  two nodes holding big tables triggers it; alternating between a Text note and a table node does
  not, because the result section unmounts and there is no previous props object to diff against.
  That asymmetry looks like a fact about tables and is a fact about React's reconciler.
- **Shrinking what was *drawn* could never have helped**, which is why capping the inspector to 25
  rows, then to one row, then replacing the table with `TableSummary` all changed nothing: the
  cost is in *passing* the table as a prop, and `<TableSummary table={table} />` passes exactly the
  same object. Three fixes aimed at rendering, and rendering was never it.
- **jsdom has no `console.timeStamp`**, so `supportsUserTiming` is false and none of this
  machinery runs under vitest. Four rounds of harness — settled heap, peak heap, realistic
  distinct strings, whole-app render — measured 4 ms and a flat heap while a browser was spending
  five seconds and a gigabyte. A headless measurement that cannot reach the code path is not a
  negative result.

`reactTracksOff()` in `vite.config.ts` switches it off by making that gate false, injected
`head-prepend` so it runs before `react-dom` initialises. **Dev server only** — the production
build of `react-dom` contains none of this machinery, so the deployed app never had the problem.
What it costs is React's own track in a performance recording; `localStorage['coda.reactTracks']
= '1'` and a reload gets it back.

The deeper reading is that **megabyte-scale values as React props are a hazard in this app**, not
because React re-renders on them but because its dev tooling reads them. Nothing here does that
today beyond the viewers, which need the data they draw; a component that wants only a *fact*
about a table should take the fact.

### What was measured, and what is still unexplained

`.inspector__viewer` is **320 × 300** — smaller than a card, and the smallest surface a viewer is
drawn on. It was passing neither `compact` nor any ceiling, so a node's own `pageSize` decided
what it drew: on a real annotation table that is **100 rows × 60 columns, six thousand cells, of
which about forty are visible**, laid out again on every change of selection. Reported as the app
freezing while zoom and pan kept working, which is the signature of a long layout rather than a
stuck script.

Measured in jsdom, which performs no layout and so isolates the *JavaScript* half: a 58,340 × 60
table renders in **113 ms** at 100 rows and **26 ms** at 25, and the cost is linear in
`rows drawn × columns` — flat in table length, so the paging was working and the row count was
never the problem. A selection switch went 101/48/73 ms to 47/24/36 ms. Twenty-four switches in a
row settle at 15 ms with no growth.

**The reported failure was memory, and none of the below explained it — see the section above for
what did.** Kept because the eliminations are still true and still useful.

 A real graph —
FlyTable → Filter → Sort → Deduplicate, with a Table tapping the Sort — reaches about 0.5 GB after
a run, which is four full copies and expected. With the inspector *closed*, switching selection
costs nothing. With it *open*, each switch adds roughly **a gigabyte**, and the tab is unusable at
5.4 GB.

Ruled out, each by measurement rather than by reading: **JS-side retention** — the same chain over
a 58,340 × 60 table, the real store and the real `Inspector`, ten switches with forced GC between,
sits dead flat at 198 → 215 → 214 MB; **re-evaluation**, since `setSelection` is a bare `set` with
no commit and no run; **eager export**, since the CSV builder is only ever referenced
(`if (source.csv)`) and never called; and **drawn cells as the cause** — the strongest clue, since
cutting them four-fold moved the memory not at all.

So it is browser-side, proportional to something other than what is drawn, and invisible to Node.
The remaining suspects are the 60 sticky `<th>` cells and `width: max-content` with
`table-layout: auto`, which forces an intrinsic-width pass over every cell — but neither
plausibly reaches a gigabyte, and `fixed` would change how every column in the app sizes. Left
alone deliberately: it is a guess until somebody points a browser at it, and Chrome's own Task
Manager splits it in one reading — if **JavaScript memory** tracks the footprint it is retention,
and if it stays flat while the footprint climbs it is DOM, layout or compositing.

`ValuePreview.maxRows` is a **cap** rather than a value, so a node whose page size is already
small keeps it, and `compact` comes with it — which also withholds the rows-per-page selector,
the one control that could put the cost straight back.

**What is measured and what is not.** The four-fold cut in cells is measured; the *browser*
half — `table-layout: auto` with `width: max-content`, which forces an intrinsic-width pass over
every cell in every column — is the remaining suspect and could not be measured here, since jsdom
lays nothing out. It is the classic pathological combination for a wide table, and `fixed` would
remove it at the cost of columns no longer sizing to their content. Left alone deliberately: it
is a guess until somebody points a browser at it, and this codebase's habit is to measure before
changing something that decides how a thing looks.

## Collapsible panels

The inspector and the minimap are both **closed by default** and remembered in `localStorage`
(`persistence.ts`, `coda.panels.v1`). The canvas is the thing; an inspector that opens by default
takes 320px before anything is even selected, which is when it has nothing to show.

Read the state as `s.panels.inspector`, never `s.panels` — invariant 7. `togglePanel` mints a
fresh object, so a selector returning the whole thing changes identity on every unrelated tick.

**Closed means not rendered, not zero-width.** A collapsed-but-present panel still catches clicks
along the right edge of the canvas, which reads as a dead strip.

Each panel has an affordance where you would look for it: the inspector has a toolbar toggle
(the lens icon; and `I`, unqualified — unlike `m`/`h` it is worth pressing with nothing selected)
plus a chevron in its own header; the minimap has a button in the corner it occupies. That button is rendered
**outside `<ReactFlow>`** so it keeps its corner whether or not the map is mounted — a toggle
that disappears when used cannot be undone.

**The minimap's size goes through its `style` prop, not CSS.** React Flow reads
`style.width`/`style.height` to compute the map's viewBox, so sizing it in the stylesheet leaves
it drawing a 200×150 projection into whatever box CSS produced: it renders, and is silently
wrong. `MINIMAP_SIZE` in `Editor.tsx` is the single constant; `.canvas-area` publishes its height
as a CSS variable inline so the toggle can clear it without a second copy of the number.

`installStorageStub()` in `test/jsdomStubs.ts` is what makes any of the persistence testable —
Node 26 shadows jsdom's `localStorage`, so by default every persistence path silently degrades
and has no coverage. Opt in per suite: with storage present, autosaves leak between test files.

### The toolbar's icon cluster

Four buttons carry an icon and no words — **Share** (a box with an arrow leaving it),
**Connections** (a branch), **Assistant** (a robot head) and **Inspector** (a lens). They are in
`src/ui/Icons.tsx`, drawn on the usual 24-unit grid with a 2-unit stroke and painting in
`currentColor`, so each takes the ink of the button it sits in and follows its hover and pressed
states. Same rule as `CodaMark`, and for the same reason: an accent-coloured icon here would be
the same blue as a Table socket and read as a typed port rather than as chrome.

**Every one keeps its name in `aria-label` and `title`.** An icon-only control with neither is a
control only its author can use — and it is the one property nothing about the rendering would
report, since the icon draws either way. `panels.test.tsx` asserts all four have a name, an
`<svg>` and no text.

**`aria-pressed` now carries what the glyph used to.** The inspector toggle drew `▐` against `▕`,
which said open-or-closed in the mark itself; an icon that does not change with the state says it
through the pressed style and the tooltip instead. Same trade `.coda-node__fold` records.

**Four messages elsewhere had to learn the icon.** "Add one in Connections, in the toolbar" pointed
at a button that no longer has the word "Connections" on it — so `client.ts`, `ai/registry.ts`, the
assistant drawer and the start page's dataset rail all name **the branch icon** now. The start
page's line was additionally stale from before: it still said *Sources*, which that button has not
been called for some time. This is the standing cost of an icon-only control, and the thing to
check when adding a fifth.

**Share leads the cluster and is the odd one out** — a verb, where the other three are toggles or a
dialog. It sat under `Save ▸` first; the menu entry is gone rather than duplicated, because two
routes to one dialog is two places for the wording to drift.

## Fullscreen, and installing

Two halves answering two different moments, and they compose rather than overlap: **⛶ / `F`**
is one session's worth of "give me the canvas now", and the **web manifest** is "this is how I
always use it". `src/ui/fullscreen.ts` is the whole of the first; `public/manifest.webmanifest`
plus three lines of `index.html` is the second.

**The app's own chrome stays.** What fullscreen reclaims is the browser's ~90px of tabs and
address bar, not the toolbar and status bar — Run, Auto-run and the stale count are precisely
what you want in view while a graph is running, and a mode that hid them would be a different
feature (a presentation mode) wearing this one's name.

**The root element is what goes fullscreen, and that is what keeps the layout identical.** The
fullscreen UA stylesheet's `position: fixed` rule is `:fullscreen:not(:root)`, so the root is
exempt: the page simply stops having a browser around it. Any wrapper `<div>` would be pulled
out of flow and have to be sized back by hand. The one thing the root does need stating is a
background — the UA paints a black `::backdrop` behind whatever is fullscreen, and `html`
carries no background here, only `body` does. Hence the `html:fullscreen` rule in `theme.css`.

**`document.fullscreenElement` is the only honest source of truth, and the button reads it
back.** Escape, F11 and the browser's own window chrome all leave fullscreen without passing
through anything in this app, so a boolean written where the toggle was clicked is wrong the
first time somebody uses any of them — and a ⛶ latched on by its own click reads as the app
having lost track of the window, which is exactly what it has done. `useIsFullscreen`
subscribes to `fullscreenchange` and returns a **boolean**, not the element, so the snapshot
is a primitive (invariant 7).

**Entering is a request, not a command.** Browsers refuse outside a user gesture and refuse
again under some kiosk and iframe policies, with no way to ask in advance — so
`toggleFullscreen` returns whether we ended up fullscreen rather than throwing, and the two
callers that can distinguish a refusal from an ordinary exit (they know which direction they
were going) are the ones that put a notice up. It is also why fullscreen is **not persisted**:
a preference restored at load would be refused, since a page load is not a gesture.

**`toggleFullscreen` compares against its own target, never against "is anything
fullscreen".** That is what lets the two halves nest: the overlay's ⛶ pressed inside an
already-fullscreen window shows the _panel_ full size instead of dropping the window out, and
the Fullscreen API's element stack means leaving the panel lands back on the fullscreen app.
The overlay's `close` and its Escape handler were both widened for the same reason — they used
to ask "is anything fullscreen?", which was only ever equivalent because nothing else could be.
Closing a viewer has no business dropping the whole window out of fullscreen.

### The manifest

**`start_url` and `scope` are relative, and that is the one thing here that fails silently.**
They resolve against the manifest's own URL, so `"."` is `/coda/` on GitHub Pages and `/` on a
dev server. An absolute `"/"` works perfectly in dev and scopes the installed app to the domain
root in production, where somebody else's site lives. `vite` rewrites the `<link rel="manifest">`
href against `base` (`'./'`) the same way it does the favicon, so the href in `index.html` stays
in the usual `/manifest.webmanifest` form. `fullscreen.test.tsx` asserts the relative form,
because nothing else would catch it before a deploy.

**There is deliberately no service worker.** Chromium's installability criteria historically
wanted one with a fetch handler, and Chrome is explicitly [walking that
back](https://developer.chrome.com/blog/update-install-criteria) — sites answered it with empty
fetch handlers, which is what a service worker here would be too. This app has no offline story
to write: every dataset it reads comes over the network. A cache that outlived a deploy is the
classic way to strand somebody on a stale bundle, and that is a real cost against a hypothetical
install prompt. Both browsers that matter install from a menu item regardless of one.

**The icons are `purpose: "any"`, not maskable.** Android's maskable safe zone is the middle
80%, and the coda sign's cross arms reach ±65% of the half-width — declaring maskable would have
the platform crop the tips off the mark. `icon-192.png` and `icon-512.png` are rasterised from
`icon.svg` with `rsvg-convert -w N -h N`; the SVG is listed first, at `sizes: "any"`, for the
platforms that take it.

**No visual verification exists.** jsdom implements no part of the Fullscreen API, so what the
suite checks is which element is handed over and how the button reads the answer back
(`installFullscreenStub` grants fullscreen the way a browser does — by setting
`document.fullscreenElement` and firing the event, never from inside `requestFullscreen`). The
transition itself, and the installed window, have not been driven by anyone here. Same standing
as the WebGL viewers.

## Canvas interaction

Set explicitly on `<ReactFlow>` in `Editor.tsx`, and each one matters:

- `panOnDrag={[0,1,2]}` + `selectionOnDrag={false}` — left-drag **pans**. Panning is far
  more frequent than box-select, so it gets the bare gesture.
- `selectionKeyCode="Shift"` — Shift+drag box-selects. Because Shift is taken,
  `multiSelectionKeyCode` is `['Meta','Control']` only.
- `panActivationKeyCode={null}` — React Flow binds Space to pan-activation by default;
  it's disabled so Space can open the command palette.

**Viewer cards resize; nothing else does.** `NodeResizer` is rendered for
nodes in the `visualisation` category only (`isViewer`, read off the definition rather than a
second hand-kept list of the same type ids) — a transform node's height is decided by its fields, so a handle
there would promise a control that does nothing. Three things about it:

- **It is a sibling of `.coda-node`, like the run ring**, and for the same reason: the handles
  straddle the card's edge and the card clips with `overflow: hidden`. `nodeResize.test.tsx`
  asserts it, because moving it inside throws nothing and just clips half of every corner.
- **Size lives in `GraphNode.size`, and `NodeDefinition.defaultSize` is only a fallback**, read
  at render time rather than stamped at creation. That is why every path that makes a node —
  palette, browser, examples, starters, a loaded file — gets a sensible size without knowing
  the field exists, and why nothing lands in the saved file until someone drags a corner.
- **Only `setAttributes` dimension changes are persisted.** React Flow emits `dimensions` for
  its own measurements too, on every mount and content change; storing those would write a
  measured pixel size into the document on load and fill the undo stack with things nobody did.

**A pointer gesture undoes to where it started.** `commit` takes a `gesture` tag, and the
uncommitted frames of a drag or resize stash the graph as it was when the gesture began. Before
that, history was recorded from the _last_ frame, so undoing a drag moved the node back one
frame — and since the final two frames of a drag are usually identical, undo after moving a
node appeared to do nothing at all.

**Two controls put a card's sockets on its header.** Collapse (`▾`) keeps nothing else; the
`☰` fold keeps the body and the footer, so a viewer's drawing gains both the param band and the
port band — which is the whole reason the fold exists. There is no ports-only state any more:
`collapsed` simply means more than it did. Wires converge near the title the way Blender's and
ComfyUI's do.

**The handles are moved, never removed, and that is the whole of it.** React Flow finds a node's
anchors with `nodeElement.querySelectorAll('.source' | '.target')` and returns `null` when there
are none, so unmounting the port rows leaves every wire on the card with nowhere to attach.
`display: none` is worse rather than safer: the element stays findable and reports a zero-size
rect, so each wire lands on the card's **top-left corner** looking deliberate. The band stays in
the DOM and the stylesheet lays it over the header.

**Over the header, not over the card.** `inset: 0` would be right only for a collapse, where the
card _is_ its header; under a `☰` fold there is a preview and a footer beneath, and centring the
sockets in those puts them halfway down a chart. So the band takes `--header-h`, declared on
`.coda-node` and applied to the header as a `min-height` so the two cannot drift — `min-` rather
than a fixed height because 28px is merely the header's natural size, and a control that grows
should grow the header rather than be clipped by it.

**Fanned, not overlapped, and three is the number that matters.** No node in the registry has
more than three ports on a side (Paths 3→3, Explore 1→3, Adjacency 3→1, Viewer3D 3→1), so a
`--port-pitch` of 8px puts three 11px discs down a ~28px header overlapping by 3. Every socket
keeps a hit target, which is what lets a dragged link still choose an input and keeps the
drag-off rewire anchors (`reconnectRadius: 14`) distinct. Exact overlap was the other option and
loses both: the topmost handle takes every pointer event.

**`pointer-events: none` on the band, never on the handles.** The band covers the header, which
owns the drag, the run button and the chevron. React Flow puts pointer events back on each handle
through its own `connectionindicator` class, so `none` costs the sockets nothing and omitting it
costs the header everything.

**This is the first thing in the app that moves a handle, which is why nothing needed
`updateNodeInternals` before.** The ports band sits directly under the header and everything
`collapsed` used to hide was _below_ it, so no collapse ever changed a socket's position. React
Flow re-measures on `dimensionChanged || !handleBounds || force`, and the height change does
trigger it — but that is the ResizeObserver's promise rather than ours, so the move is declared
explicitly, on either state changing. Behind a mount-seeded ref: `updateNodeInternals` writes to
React Flow's store, and firing it on mount would be one store write per card at load for
measurements it is about to take anyway.

**A collapsed card keeps its width and gives up its height.** `rfNodes` withholds `height` from a
collapsed node so the wrapper hugs the header, and `[data-sized]` was split — it now means "the
wrapper carries a width", with the box-filling half under `:not([data-collapsed])`. Both halves
matter, and this was a live bug before the change: a collapsed Scatter left a header floating in
the top-left of its 460×380 wrapper, with `.coda-node::before` inset against that _wrapper_, so
the state bar hung 330px below the card as a coloured line with nothing beside it — the same
failure `defaultSize` on a non-viewer causes. Measured after the fix: wrapper `width: 460px` and
no height, box 460×52. Keeping the width is what stops a 560px card becoming a 232px one on its
way to a title bar and moving every wire on it twice.

**What it costs is the port labels.** Socket types are distinguished by colour _plus_ shape _plus_
a visible label because only three chromatic families clear the all-pairs colourblind gate on this
surface — so a folded card is carrying one channel fewer, with the socket's `title` as the only
prose. A real trade, taken deliberately for a state somebody chooses and reverses.

**This one _was_ looked at in a browser**, unlike most of the canvas — playwright against the dev
server, folding and collapsing a Connectivity node and a boxed Scatter. Worth recording, because
it settled something the CSS alone could not: **folded sockets are not clipped and expanded ones
are.** Expanded, a handle's containing block is `.port-row` inside `.coda-node`'s
`overflow: hidden`, so the discs render as half-circles flush with the border; the folded band is
absolute against React Flow's wrapper, which is _outside_ that clip, so they come out whole. It
reads fine — arguably better — but the two states genuinely differ, and anyone matching one to
the other should know why. `collapsedPorts.test.tsx` still pins only the DOM and the
declarations, since jsdom performs no layout.

**Param rows fold away** (`GraphNode.paramsCollapsed`, the `☰` in the card header). A card is
configured once and then read for the rest of the session, so the rows that set it up go on
spending its height on a decision already made — five of them on a bar chart, above the chart.

**Every card that draws a band, not only the viewers.** On a viewer the freed height goes to the
drawing, which is the case this was built for; elsewhere the card simply gets shorter, which is
worth having on its own — a settled pipeline is a row of decisions already made, and reading the
graph then means reading the titles and the wires.

**The button lives in the header, and that is what makes the fold safe on a card with nothing
under the rows.** It survives the band it hides, so there is always something to press — the same
rule the minimap's corner button and the overlay's Style button follow, and the reason the
viewers-only restriction this shipped with was dropped rather than worked around. Its glyph does
not change with the state and does not need to: the rows are either on the card or they are not,
which says it louder than a pair of arrows. The pressed style carries that fact for a pointer that
has not moved yet, and `aria-pressed` for a reader who cannot see the card at all.

**Distinct from `collapsed`, which is the neighbouring control.** Collapse takes the port labels,
the footer's summary and any preview; a folded card still says what it is holding and what it is
wired to. That difference is what stops the pair being one control wearing two glyphs.

**It is in the document, like `collapsed` and `size`.** A workspace set up for reading has to
reopen that way; absent means shown, so every graph saved before the flag existed looks exactly as
it did. And it costs no run — not a param, not in the provenance key, committed with
`autoRun: false` — because a graph going stale when somebody tidies a card reads as a scheduler
bug. Same standing a resize has. `liveNodes` filters the selection for the same reason mute and
collapse use it: a text note draws its own card with no header and no band.

**No band, no button.** A node whose params are all `advanced` (`out.neuroglancer`, deliberately —
a row of pickers above a 400px embed is what `advanced` was for there) and every node with a body
of its own, which renders its own controls instead of the generic rows. The card computes this
from `visibleParams.length`, so it is one rule rather than a list.

**Where the space actually goes depends on `data-sized`.** A card with an explicit box — anything
resized, plus Scatter, Profile and Neuroglancer by their `defaultSize` — gives the freed height to
the preview, which is `flex: 1`. An untouched card with no `defaultSize` sizes to its content, so
folding makes the card shorter and leaves the preview at its 210px cap. Raising that cap on the
fold was declined: it is a second magic number for a case one drag of a corner already answers.

**A card says how much of itself is not on it** — `… 4 more (1 changed)`, right-aligned at the
end of the param band, opening the inspector on that node when clicked. `advanced` params never
reach the card and the inspector is closed by default, so a node with settings on it and one
without looked identical. `configurableParams`, `hiddenParams` and `changedParams`
in `core/node.ts` are the rule, headless.

**Two counts answering two different questions.** _How many are hidden_ is a fact about the node
type and never moves — it is the general indicator, and it is what tells someone there is
anything to look for. _How many were set_ is about this particular node, and it is the half worth
a step of ink, on the same reasoning `validateColumnParams` uses: a default was never a decision.
Hence one line with two clauses rather than two markers, and hence the changed clause simply
absent when nothing has been touched. (A first pass showed the marker **only** when something had
been changed. Across the five bundled examples that lands on 4 nodes of 29 against 16 — quieter,
and wrong for the question actually being asked, which is "what else is there".)

**"More" becomes "hidden" when the hidden ones are all there are.** `… 9 hidden` on Neuroglancer,
`… 1 hidden` on Skeletons — "more" is a claim about something else being on the card, and on
those there is nothing. The question is asked of `activeParams` rather than of the rows that were
drawn, because a node with a body of its own renders controls nothing here can enumerate:
Explore's search box is on the card, so its five advanced params stay `more`.

**Not gated on the band it sits at the end of.** The cards needing it most draw _no_ rows at all:
`neuron.skeletons` has exactly one param and it is advanced, so an empty body was the whole of
what the card said about itself. It does go away with a fold, which is the one case where
something else on the card — the `☰` in its pressed state — is already saying there is more here.

Three exclusions, each of which would otherwise be a false claim. **`visibleIf` first:** a param
the current values have switched off is inapplicable rather than hidden, or the number moves as
unrelated modes are chosen. **`ParamBase.internal` next:** a nonce or a pager is machinery a
widget writes, not a setting — without it a dataset card announced `… 1 more` about its `refresh`
counter, and turning a page in Profile had the card claim a parameter had been changed. It stays
a real param, saved and reachable in the inspector, because the escape hatch is sanctioned; the
flag only stops anything _advertising_ it. Note it is not a synonym for `advanced` — Explore's
`Rows per page` sits beside `page` and is inspector-only for space, but it is somebody's
preference and stays countable. **An absent value is not a change:** loading does not fill missing
params with defaults, so a graph saved before a param existed has no key for it, and comparing
that against the declared default reports a change on every older file.

Both sides of the "are the hidden ones all there is" comparison come from `configurableParams`,
or a node whose one other param were a nonce would say `more` while drawing nothing.
`hiddenParams.test.tsx` asserts that every `refresh` in the registry carries the flag, since the
next dataset-shaped node will grow one and nothing else would catch it.

`align-self: flex-end` puts it under the _fields_ rather than the labels, since it is about what
is missing from the right-hand column, and the tooltip **names** the params — marking the changed
ones — rather than printing their values, which an `ids` param holding four thousand neuron ids
would not survive. The click reads the store through `getState()` rather than subscribing, or
every card re-renders whenever the inspector is toggled from anywhere; and it checks
`panels.inspector` before flipping it, because `togglePanel` is the only setter there is and a
button meaning "show me" must not close an inspector that is already open.

There are **two** add-node surfaces, on purpose:

- `NodeBrowser` — big centred modal with thumbnails and category chips, for browsing. Opened
  by Tab / ⇧A / the + Add button / the `Add ▶ Browse All Nodes…` command.
- `CommandPalette` — compact keyboard list, for people who know the name. Opened by Space
  (everything), by canvas double-click / pane right-click (prefilled `Add:`), and by
  dragging a link into empty canvas (filtered to compatible types, and it wires the pick up).

`NodeThumbnail` derives everything from the `NodeDefinition` — header tint from category,
dots from real ports. The centre glyph is keyed to the **category** so six drawings cover
every node; `NODE_GLYPHS` overrides that only for the three viewers, whose identity is a
visual form. Never make thumbnails require per-node artwork: a future node would ship with a
blank preview. A test renders one for every registered node to enforce that.

In `NodeBrowser`, chips and search are mutually exclusive — typing clears the chip, a chip
clears the query. Don't "fix" this into chip-as-hard-filter: that reintroduces empty results
with no visible cause.

The palette's item list comes from `paletteItems.ts`, rebuilt on every store change so
`disabled` flags stay honest.

`PaletteItem.action` does double duty: it's the first breadcrumb segment _and_ the
`Action:` filter prefix (`PALETTE_ACTIONS` is the recognised set). Prefixes are a filter,
not a mode — `parsePaletteQuery` strips the prefix, the item list is narrowed by action,
and the remainder is fuzzy-matched, so deleting the prefix widens the search back out.
Rows render as `action ▶ group ▶ name ▶ description` with only `name` in primary ink; that
single contrast step is why the list needs no group headers.

The palette is keyed by `menu.seq` in `Editor.tsx` so reopening resets its search box to
the new prefill instead of keeping the previous query.

Both store-driven open signals (`paletteRequest`, `browserRequest`) are guarded by a ref
seeded at mount, because the store outlives the component: without it, any remount after an
earlier request re-fires it and the widget pops open unprompted.

Note `fuzzyMatch` tries every occurrence of the query's first character as an anchor rather
than scanning greedily once — without that, "res" ranks "Clear Results" below an item whose
_description_ starts with "Rescale", because greedy takes the `r` in "Clea**r**".

## Dropping a node onto a wire

Drag an **unconnected** node over an existing link and let go: `A → B` becomes `A → node → B`.
The wire highlights while the card is over it, so the drop is never a surprise. `core/splice.ts`
holds every decision, `ui/spliceHit.ts` the geometry, and the split is the usual one — jsdom
performs no layout, so a path has no length and the geometry half cannot be tested at all.

**Only an isolated node splices**, and that is not tidiness. A drag across a busy canvas passes
over many wires, so a node already wired — one somebody is *rearranging* — would rewire the graph
on any drop that happened to land on one. A node with no links has nothing to lose and is almost
always one just added.

**The downstream link is judged against a graph with the upstream one already applied**, which is
the decision the whole thing turns on. A node's output type routinely depends on its input:
`core.filter` isolated publishes `T.table()` and only becomes `neurons` once something
neurons-shaped reaches it — so checking both links against the *current* inference refuses a
Filter dropped on `Find Neurons → Skeletons`, which is the most obvious thing anybody would try.
One re-inference, then the first compatible output; a node whose *second* input would have worked
where its first did not is missed, which is the same "first compatible" simplification the
palette's link-drag already makes.

**The hit test walks the drawn path**, not a line between the sockets. `isPointInStroke` against
the card's centre was the obvious route — React Flow already draws a fat `interactionWidth` copy
of every edge — and it makes the target ±10 flow units around a hairline, which is a precise aim
for a whole card thrown across a canvas. Sampling the path and asking whether it enters the card's
rectangle is more forgiving and is what "drop it on the wire" means; walking the *rendered* path
also means an orthogonal step and an ELK route are judged where they are drawn, with no geometry
of our own. The card's size comes from `offsetWidth` for the reason `useArrange` records at
length.

**The move and the rewire are one `commit`, under the drag's own gesture tag**, so ⌘Z lands on the
graph as it was before the drag began. Two commits would be two undo steps, the first of which
leaves the graph rewired around a card in its new position — a state nobody was ever in. Unlike a
plain move it *does* re-run, because the dataflow changed.

**The ports are re-derived at the drop rather than carried from the drag.** The candidate was
computed on a pointer move; positions do not reach inference, so the answer is the same one the
highlight showed, and passing it would be a second copy of a decision that can only disagree.

One note on `spliceGraph`, because the comment there was wrong first and mutation testing caught
it: the original link is removed **explicitly**, but `addEdge` would evict it anyway — the
downstream link targets the same `(node, port)`, which is exactly its eviction rule. So the order
does not matter, and the removal stays because relying on that coincidence would hold only while
both links land on one input.

## Reference edges — a port that names a node

`PortDef.reference` marks an **input that names a node rather than consuming its output**. It
creates no ordering dependency: excluded from `topoSort` and from `wouldCreateCycle`, never waited
on by the scheduler.

It exists for one wiring, and that wiring is a node's own documented use: `Dataset → CAVE table →
Dataset`, a datastack's annotation table handed back to that datastack as its labels. Two edges
between one pair in opposite directions, which at *node* granularity `topoSort` reads as a cycle —
both cards went dark with no result and nothing naming the cause. At *port* granularity there is
no cycle at all, and that is the whole insight: `CAVE table`'s output needs the annotation table,
not the dataset ref; the Dataset's output needs the annotations schema, not `CAVE table`'s ref. A
node cannot half-run, so the sort cannot see it.

**What makes it sound is a property of the upstream node, not a promise from the downstream one.**
A dataset node's identity is a function of its params alone —
`T.dataset(family.sourceId, resolveDatasetId(family, params.version), annotationSchemaFrom(…))`,
where only the third argument comes from an input. So a reference reads something knowable without
running, or even inferring, anything downstream. **Check that before marking a new port
`reference`**; it is the condition the whole mechanism rests on.

Five places implement it, and each was mutation-checked because every failure here is silent:

- **A registry-level short-circuit first.** Exactly one node type declares a reference input, so
  `typesWithReferenceInputs()` lets every walk ask "could this graph hold one at all?" without
  touching an edge — and on every graph without one, `dataflowEdges` returns `graph.edges` itself
  and allocates nothing. Measured 1.4 µs → 0.13 µs; `topoSort` runs twice per keystroke and
  `wouldCreateCycle` once per pointer move of a link drag. The memo is **cleared by
  `registerNode`** rather than assumed fixed, because a type registered afterwards would otherwise
  be invisible and the round trip would read as a cycle again — pinned by a test that warms the
  memo *before* registering.
- **`dataflowEdges` in `graph.ts`, and nowhere else.** One filter, inside the one index from which
  `topoSort` derives *both* the indegree count and its decrement — the arrangement that function's
  own note demands, after the bug where the two came from different places and a target joined
  twice never reached zero. Filtering anywhere else would bring that back wearing a reference's
  clothes.
- **`wouldCreateCycle` takes the target handle**, because the wire *being drawn* can itself be a
  reference and then can never close a loop. Without it the editor refuses exactly the wiring this
  exists to allow.
- **`checkConnection` no longer walks its own edges.** It had a second reachability implementation
  over `graph.edges` — one statement of a question `wouldCreateCycle` already answered — and the
  two had to be found together: one knew about references and the other refused every wire.
- **Inference resolves a reference type in isolation**: the source node's `inferOutputs` with *no
  inputs at all*. It cannot recurse, so the walk terminates, and for a dataset it yields exactly
  the identity without the annotations schema — the honest answer as well as the terminating one,
  since a node cannot read the annotations it is itself about to supply. Through `outputTypesFor`,
  which the main walk also uses, so "a reference is the same node inferred with no inputs" is
  literally true rather than a second implementation that resembles it: the two had already parted
  company on the merge rule (`if (type)` against `?? declared`) and on whether a throw becomes an
  issue.
- **The scheduler neither waits nor keys on the upstream.** `evaluate` is handed the value
  `datasetIdentity(type)` builds, and the provenance takes `referenceKey(type)` in place of the
  upstream node's key — which it *must*, since that node is outside the order and its key may not
  exist yet. It is also the better key: changing the dataset's version re-keys the reader,
  changing its annotations does not, and the reader never sees them. Both are single functions for
  `upstreamKey`'s stated reason — the key is read by the two consumers that must not disagree, and
  it was written out twice at first. `datasetIdentity` lives beside `DatasetValue` in `values.ts`
  rather than in the scheduler, because it is the type→value projection and it is **partial**: no
  annotations, and `label` is the dataset id rather than the human name an ordinary wire carries.

**Deliberately narrow: a Dataset socket that takes the identity only, not a general information
edge.** Synthesising a value from a type is defensible exactly because a dataset's identity *is*
its type; there is no second kind asking, and a general mechanism would have to answer that
question for every one of them.

The canvas draws it **dotted** — a wire already wears the colour of the data flowing through it,
so a hue would read as a type, where what this has to say is that nothing flows.

**Writing the graph out wants the opposite order, and both exporters take it.** `topoSort` leaves
references out because the reader waits on nothing; a *cell* that names the referenced node needs
that node's own line to exist already. `exportOrder` in `src/export/order.ts` hoists them and both
walks call it — one function rather than two lines copied into each, and in the layer whose
vocabulary the rationale is written in. The copy doctrine protects the *assembly* walk (chunks,
variable naming, unwired-versus-blocked); an ordering rule with no language in it is the same
class as `canExport.ts`'s refusal policy, which both surfaces already share.
Without it —
without it the reader is classified `blocked by "Dataset"` and emits a TODO that is false and
cascades to everything downstream. The condition that makes the hoist valid is the same one that
makes references sound: **a referenced node's cell must be writable from its params alone**. A
dataset's is — a `Client(…)` naming a datastack and a version — which is why it can be lifted
above the annotations wired into it, and it is the thing to check when writing an emitter for a
node anything references.

Unreachable today, and deliberately built anyway: every CAVE node sits in `NO_EMITTER` and a CAVE
dataset refuses export outright, so the only reference port in the tree is on a node with no
emitter. The day a caveclient emitter is written it would fire, and it fires as a *plausible*
TODO rather than as an error. `reference.test.ts` covers the ordering; the end-to-end case has
nothing to exercise it with until that emitter exists.

## Breaking and re-routing links

Two gestures, and the pair is the design: **right-click a wire** for a menu, or **drag either
end off its socket** to re-route it — drop on another socket to move it, on empty canvas to
unplug. A hover ✕ on the wire and a Blender-style cut-across-several drag were both considered
and declined; the first puts chrome over the canvas for a rare action, the second is a tool with
no visible affordance at all.

The Delete key on a selected wire has always worked — React Flow selects edges, `deleteKeyCode`
is set, and `onEdgesChange` handled `remove` long before any of this. It was simply the _only_
route, and nothing on screen said so. Treat it as a shortcut that exists, not as the answer.

**A rewire keeps the edge's id, and that is what makes it one undo step.** `reconnectEdge` in
`core/graph.ts` removes and re-adds under the same id rather than minting a new one. Two reasons,
both load-bearing: React Flow keys wires by id and the reconnect drag is _still in flight_ when
this runs, so a fresh id remounts the element being dragged; and a delete-plus-add is two history
entries, which means ⌘Z leaves the link unplugged halfway through a gesture that finished. Note
the ordering inside it — the removal comes first, because `addEdge` evicts whatever already
occupies the destination input, which is not necessarily the edge being moved, so adding first
would leave two edges sharing one id.

**`connectionState.toHandle` is the discriminator in `onReconnectEnd`, and it is the only honest
one.** React Flow sets it whenever the drop landed on a socket, valid or not. So:

| dropped on                        | `toHandle` | what happens     |
| --------------------------------- | ---------- | ---------------- |
| a socket that accepts it          | set        | rewired          |
| a socket that refuses it          | set        | snaps back, kept |
| empty canvas (or a card's middle) | null       | unplugged        |

The classic React Flow pattern — a `reconnectDone` ref, delete when no reconnect fired — cannot
express the middle row, and that row is the point: a mis-aimed drop onto an incompatible port is
a miss, and answering a miss by also cutting the link makes every failed re-route destructive.
`onReconnectEnd` runs _after_ `onReconnect` on a successful drop, which is the other reason "no
reconnect happened" is not a usable signal.

**The link being moved stays in the graph while the rewire is validated, and that is safe rather
than sloppy.** `createsCycle` walks _forward_ from the proposed target, and the edge being moved
points into its old target, so it can never appear on a path leading back to the source — for
either end of the grab. Excluding it would mean a second, near-identical validation path for a
case that cannot arise. A rewire is otherwise checked by exactly the `checkConnection` a fresh
drag runs, so a refusal reads in the same words.

**The menu carries a header naming both ends** — `Find Neurons ▸ Neurons → Filter ▸ Table` — because
wires overlap and on a dense graph the one under the pointer is often not the one you meant. A
menu whose only item is destructive has to say what it is about to cut. It is styled as a caption
rather than a disabled row, which would read as an action that is currently unavailable.

**`.react-flow__edge.updating` is the only thing advertising the drag-off gesture.** React Flow
puts an invisible circle just outside each socket, offset along the wire, and adds that class
while the pointer is over one; with no rule for it nothing on screen distinguishes "over the
wire" from "over the end you can pull off". The anchors sit outside the card rather than on the
socket, which is what keeps them clear of the socket's own "drag a new link out" gesture.
`reconnectRadius` is 14 against a default of 10 — the anchors swallow pointer events, so the
number is a tax on panning near a socket, and a bigger grab target costs canvas either side of
every node.

**No canvas-level test exists, and cannot.** React Flow draws no wires for nodes jsdom never
measured, and the anchors are SVG circles driven by pointer capture. `store/links.test.ts` pins
the semantics and `ui/panels/edgeMenu.test.tsx` the menu — but the gestures themselves have not
been driven by a real pointer over a real wire by anyone yet, same standing as the WebGL viewers.

## Grouped params — the styling sidebar

`ParamBase.group` and `ParamBase.composite` plus `NodeDefinition.paramGroups` turn a node's
flat param list into a tabbed panel in the expanded viewer. `out.network` is the only node
using it so far; Cytoscape's Style tab is the reference.

**It is opt-in, and the opt-out is the absence of `paramGroups`.** A node declaring no groups
keeps the flat horizontal rail it has always had, which is why adding this changed nothing for
the heatmap, the bar chart or the table. `overlay.test.tsx` asserts both halves.

**A composite is a statement about params, not about pixels.** An encoding is three params —
a mapping mode, a column, a constant — because that is what the graph has to _store_; on
screen it is one property with one label. `composite: { key, role }` binds the facets, with
`primary` (how the property is driven), `value` (what by) and `extra` (modifiers like a size
range). The two `value` members of a colour are `visibleIf`-exclusive, which is exactly what
lets one slot hold the column picker or the swatch and never both. It lives on the definition
rather than in a UI registry because deriving it from the `<prefix>ColorMode` naming
convention would be string-matching a factory's output, and rots the first time an encoding is
written by hand.

**Nothing is ever dropped.** A param whose `group` names no declared tab, or which has no
group at all, lands in a trailing `Other` tab rather than disappearing — a control that
silently vanishes is far worse than an untidy tab. `groupParams` is pure and tested against the
real `out.network` definition, and the load-bearing assertion is that the panel shows _exactly_
the set the rail's old filter produced.

**Composite keys are scoped per tab.** Both the node half and the link half call their row
"Label"; a global key would move one control into the other's tab.

**The sidebar's collapse is `panels.style`, and it defaults open** — unlike the inspector and
the minimap, whose closed default is a canvas argument that does not apply inside a modal
nobody opens by accident. Note the inverted read in `loadPanels`: an absent key means open, so
a preference written before the key existed is not read as the user having closed it. The
toggle is in the overlay header, _outside_ the panel it controls, for the same reason the
minimap's button is outside the minimap.

**The panel still shows presentational params only.** That filter is what makes the surface
safe to touch, and it is passed into `groupParams` rather than baked into it — which is the
hook a Filter tab of non-presentational params would come in through, along with something in
the UI admitting that those _do_ stale the graph.

**And `out.network`'s card draws only `Layout`.** Thirty-three params is the largest set in the
registry; fifteen of them showed at once on the default settings, as a column of generic pickers
stacked above the drawing they configure. Everything else is `advanced` now, which is the same
call `out.neuroglancer` and `out.rois` make and is cheaper here than on a smaller node, because
`advanced` is read by the _card_ alone: `paramsForPanel` and `groupParams` never look at it, so
every one of them still reaches the styling panel under the tab it was grouped for, and the
inspector still shows the full set. The `… 24 more` hint is what says so.

Two params are not styling and were still decided the same way. `Layout` stays because it is the
one control that decides what the picture _is_ rather than how it looks — and because a card with
no rows at all loses its `☰` fold and reads as a node with nothing to set, which is exactly what a
viewer this configurable should not be mistaken for. `selection` goes, though it is neither
styling nor layout: its row said `3 nodes · clear`, which the caption already says and clicking
the canvas already does.

Note what pins it. A param added without the flag fails no type check, is not caught by
`paramGroups.test.ts` — which asks about the panel, where `advanced` changes nothing — and simply
appears on the card, so the column starts growing back one param at a time. `network.test.ts`
asserts the card's contents exactly.

## Output widgets

`ValuePreview` picks a viewer by node type, then by value kind, and forwards a shared prop
bundle (`baseName`, `onExpand`, `onError`, `compact`) so a new viewer cannot silently ship
without export or expand.

- **Export** lives in `ui/export.ts`. CSV is built as chunked `Blob` parts rather than one
  string, because a 500k-row table would otherwise allocate ~30MB at once. SVG export
  clones the live `<svg>` and inlines the resolved `font-family` — the charts compute all
  their colours as literal hex in JS, which is the only reason vector export is nearly
  free; if a viewer ever starts using a CSS variable for a fill, exported files will lose
  that colour.
- **Tooltips are positioned in container coordinates, never viewport ones.** `.chart-tooltip`
  was `position: fixed` with `left: event.clientX` for the life of four viewers, which is
  correct everywhere except the place they are usually read: a **transformed ancestor becomes
  the containing block for `fixed` descendants too**, and React Flow's viewport pane carries
  `transform: translate(…) scale(z)`. So the tooltip was right in the expanded overlay, which
  sits outside that pane, and hundreds of pixels adrift on a node card. Measured before the
  fix: a dendrogram bracket hovered at (1254, 417) put its tooltip at (1787, 498), a heatmap
  cell at (1098, 655) put its at (1693, 950).

  Two corrections, and only doing one leaves it subtly wrong: the pointer has to be made
  relative to the containing block, **and** the distance divided by the zoom, because a length
  inside a `scale(z)` pane is drawn `z` times as long. `offsetWidth` ignores transforms where
  `getBoundingClientRect()` has applied them, so their ratio *is* the zoom — the identity the
  auto-layout measurement leans on. `tooltipPoint()` is that, shared by Heatmap, Bar Chart,
  Scatter and Dendrogram; `NetworkViewer` never had the bug because it was already `absolute`
  over sigma's container coordinates, which is what `.viewer`'s own `position: relative` comment
  describes. Verified in a browser at three zoom levels — the gap tracks the camera at 4, 7 and
  10 px for 0.35, 0.60 and 0.86, being one constant 12 local px throughout.

  Note what the fix depends on: the container passed must be the tooltip's **containing block**.
  That is `.viewer__scroll` for three of them and `.viewer` for the scatter, whose tooltip is a
  sibling of its plot box — passing the wrong one is off by that element's own offset, which on
  a card looks like a styling choice rather than a bug.
- **Fullscreen** uses the real Fullscreen API on the overlay panel. `.overlay__panel:fullscreen`
  resets the backdrop padding and rounding, because in fullscreen the panel _is_ the root
  element and would otherwise render as a floating card with bars around it.
- **Table sorting is view-only** and shares `sortedRowIndices` with the Sort node, so null
  placement and numeric-vs-locale collation can't diverge between the two.
- jsdom has no `URL.createObjectURL`, no navigation and no Fullscreen API.
  `installDownloadCapture()` in `test/jsdomStubs.ts` intercepts the anchor-click download so
  tests can assert filename and content.

### Downloading a result

Two surfaces, one decision function. `ui/exportValue.ts`'s `formatsFor`/`planExport` answer what
a value can be written as and what the files are called; the **Download node**, the **viewers'
caption bar** and now **every card's foot** all read the same answer, so a format added in one
place appears in all three and none of them can disagree about a filename.

**A network exports as GraphML**, alongside the two CSVs it has always written. Chosen over GML —
the other format Cytoscape, NetworkX, Gephi, igraph and yEd all read — for one reason: it is the
only one that carries Coda's attribute tables *with their types*. A `<key>` declares `attr.type`
up front, so `i64` arrives as a long and `f64` as a double rather than as whatever the reader
infers from the first literal it meets, and an absent value is an omitted element rather than a
zero somebody has to notice. GML implies types by literal syntax and restricts key names to
something `sum_neuronId` survives and `pt root id` does not.

**Attributes only — no positions, no colours.** So the Network viewer and Build Network write
byte-identical files for the same network, and the document says what the data says rather than
what one viewer happened to be showing. Every reader here lays a graph out on import anyway.

Four things in the writer that each produce a plausible wrong file:

- **A null is an omitted element, never a zero.** The same trap `numeric()` exists for, one step
  downstream: a written `0` is a reading. A non-finite number goes the same way — XML Schema does
  spell `NaN` and `INF`, but the readers disagree and a number nobody can compare is not worth a
  parse error. An **empty string is kept**, unlike a null, because this is a serializer: an
  omitted element reads back as a missing key and turns a blank cell into a `KeyError`.
- **XML 1.0 forbids most C0 control characters outright**, and there is no escape for them —
  `&#1;` is as illegal as the byte, so a document carrying one is *rejected* rather than read
  leniently. `xmlText` strips them; tab, newline and carriage return are legal and stay. Written
  as `\u0000`-style escapes for the reason `uploads.ts` records about its separator.
- **`id`, `source` and `target` are never repeated as attributes**, the same subtraction
  `keptEdgeColumns` makes: an id written twice becomes a redundant column beside the one the
  reader keyed on.
- **`<key>` ids are generated (`nd0`, `ed0`), never the column name.** A key id is an XML ID and a
  column name is arbitrary text; `attr.name` is what NetworkX reads back, so the generated id
  costs nothing.

The document is built as **string parts, not through `XMLSerializer`** — the whole point of
chunking at 2,000 rows is that a 20,000-node network never becomes one huge string, and a DOM is
that string plus an object per element. `exportValue.test.ts` still asserts against a *parsed*
document (hence its `@vitest-environment jsdom`), because a snapshot of well-formed-*looking* XML
is exactly what a file with an unescaped `&` in a region name produces.

**CSV stays what `auto` picks.** GraphML is the better file for Cytoscape and NetworkX; a
spreadsheet cannot open it at all, and `auto` is what somebody gets without choosing.

### The ⤓ in a card's foot

`ResultDownload`, rendered in `.coda-node__footer` for any card whose result `planExport` can
write. Downloading a node's output used to mean wiring a Download node beside it — the right
answer for a repeatable pipeline and the wrong one for "let me have that table", since a download
is a verb people look for on the thing.

**Withheld where the card is already drawing a viewer.** That card carries its own ⤓ an inch
above, and it is the better of the two: it can offer the picture as SVG and PNG, which no amount
of looking at the value can produce. Same rule the `… N more` hint follows when it stands down on
a fold — do not say the same thing twice on one card.

**The rule bites on the dataset cards, and that is recorded rather than special-cased.**
`formatsFor` never comes back empty for a real value, because JSON is the universal fallback — so
"any node whose result is downloadable" is really "every node with a result", and the nine dataset
nodes gain a ⤓ writing a four-line JSON handle. It was kept because that file is valid and
meaningful (it names the *resolved* version, which is the provenance question an unpinned
`Latest` leaves open), so it is a control that delivers rather than one that promises. The
narrowing, if it ever reads as noise, is `defaultFormat(value) !== 'json'` — one predicate, no
list — and `resultDownload.test.tsx` is where that case is pinned.

**`DownloadButton` is shared, not copied.** The ⤓, its menu, the dismiss and the busy state are
one component behind both `ViewerActions` and `ResultDownload`; the callers differ only in what a
format is called and what picking one does, because one asks a live viewer for its picture and the
other asks `planExport` about a value. Same call as `LegendKeys`, extracted from `NetworkLegend`
for the same reason. It carries its own `.download-button` positioning context: the menu is
absolute against it and must not anchor to the surrounding row, which holds ⤢ in a caption bar and
the summary in a foot.

### An identifier is not a quantity

`formatCell` takes the **column name** as well as the value, and a column of identifiers is
printed verbatim: `527536`, not `527,536`. A thousands separator is a reading aid for
magnitude, and an identifier has none — body 527536 is not five hundred thousand of anything,
so the grouped form is a string no query accepts, and under another locale it is not even the
same string, which makes a column copied out of the table disagree with itself between two
machines. Worth knowing that the Table viewer's cell `title` has always been `String(cell)`,
so before this the hover and the cell under it disagreed on every id.

**The rule is the name, because nothing in a `DType` can say it.** That is the same gap
`BuildNetwork`'s merge rule documents — "summing added `preId` up to 24093454514" — and the one
the upload node's `Text columns` exists for; `isIdentifierColumn` in `ui/format.ts` is those
two answers applied to the formatter. It reads the name's **last word**, split on separators
and camelCase, which covers `neuronId`, `preId`/`postId`, `partnerId`, `sourceId`/`targetId` and
the `root_id` / `pt_root_id` spellings an uploaded CSV arrives under with no list to keep in
step. A plain `endsWith('id')` is not the same rule and is wrong: `centroid` and `valid` are
words that happen to end that way.

**An aggregate of an id column is a quantity again**, and is excluded by its prefix, derived
from `AGG_OPTIONS` rather than typed out. `groupBy` writes `<agg>_<column>`, so a count of
distinct partners is literally called `countDistinct_partnerId` — five figures on male-CNS, and
it does want its separator. What that costs is a column somebody else called `max_id`, which
reads as an aggregate and keeps its grouping; taken deliberately, since `sum_neuronId` is a name
Coda generates and `max_id` can only arrive in a file.

**The name is optional and absent means "a quantity"**, which is what every caller did before
it existed. It is passed wherever the caller has one — the table cell, the network tooltip and
edge label, the scatter tooltip's label/colour/shape rows, the Profile and Explore chips.
`Tiles`' `Facts` takes label/value pairs with no schema behind them and is left alone.

`format.test.ts` pins the rule and `viewers.test.tsx` pins the wiring, because a cell rendering
`formatCell(cell)` with the name dropped fails no type check and looks exactly like the bug
this fixed.

### Filtering a table, and the port it feeds

Each column header carries a filter field, and what survives leaves by a second output,
**`Filtered`**. `nodes/lib/tableFilter.ts` is the whole of the semantics, headless — the widget
filters its own copy on every keystroke and `evaluate` filters the real one on the committed
param, and a second implementation in the UI would draw a row count the port does not honour.

**A cell is the right-hand side of an Explore field term.** `>=10` under a count means what
`weight>=10` means in the Explore box: same operator table, same null rule (a missing value
satisfies `!=` and nothing else), same comparison semantics, because `resolveFilters` builds
real `FieldTerm`s and hands them to `neuronSearch.ts`'s own matcher. That reuse is why
`prepareFieldTerms`/`fieldTermsMatch` were extracted out of `runSearch` — two loops over one
matcher, rather than two matchers that part company on the first null. **Do not re-implement
the comparison here.**

**What a cell decides that a query token does not is the meaning of a bare value**, and it is
decided from the column's dtype. On a number `10` is `== 10` — read as a substring it would
match 100 and 210, which is nobody's intent in a synapse count. On text it is a substring,
compiled as an *escaped* regex so `LC4(R)` matches itself rather than being read as a group.

**It does not agree with the Filter node, and that is recorded rather than fixed.** The header
*sort* shares `sortedRowIndices` with the Sort node on a stated rule — collation and null
placement must not differ between a node and a header click. The header *filter* borrows
Explore's grammar instead, so it lands elsewhere on both. Measured: `type == "lc4"` keeps 0 rows
in a Filter node (case-sensitive) and 1 in a header cell; `pre == 0` against a null keeps the
null row in a Filter node (`Number(null)` is 0) and none in a cell. Neither is wrong on its own,
but a graph can hold both an inch apart, so `tableFilter.ts` and `filterTable` each name the
other. Folding one onto the other is a decision about which semantics wins and changes what
every saved `core.filter` returns — not a tidy-up.

**Nothing in it ever throws.** A half-typed cell, a regex that does not compile, a column an
upstream edit removed — none of those may block the graph, because `out.table` is a tap and a
refusal there reaches everything downstream of the *pass-through* too. A clause that cannot be
applied is dropped and reported; `validate` says so on the node and the cell wears
`data-invalid`. Note which way that errs: dropping shows **more** rows than intended, where
letting an unresolvable column reach `prepareFieldTerms` marks it `unknown`, which matches no
row — so one stale column name would empty the table and read as a node that had broken.

**A problem carries its column beside the message, never inside it.** The cell that draws the
red border has to know which column a problem belongs to, and recovering that by substring-
matching the prose is both fragile and wrong: `Filter on "pre": "abc" is not a number` quotes
the offending *value* too, so a table with a column called `abc` would see that column marked
broken. Same reasoning as `reportAuthFailure` — matching on message text rots silently.
`validate` flattens to strings for the badge; the viewer indexes by column.

**`filterRowIndices` answers `undefined` for "every row", not an identity array.** The
unfiltered case is the common one and a table here can be the whole of male-CNS, so
`Array.from({length}, (_, i) => i)` is 165,000 elements built and discarded — once per
`evaluate` and once per *render*. Both callers already treat "all rows" specially, so the
sentinel costs neither a branch.

**Filtering is data; sorting is still a view.** The two controls sit inches apart and mean
opposite things, so the caption carries both: `5 of 6 rows` for the filter, `sorted view only`
for the sort. Sorting stays out of the provenance key deliberately — a header click is the
cheapest gesture anyone makes on a table, and staling the graph for it would read as a
scheduler bug.

**The bill, which is not visible from the port that pays it.** A cache key is one per *node*, so
editing a filter invalidates `out.table` whole and reaches a chain hanging off `Table` as well —
whose bytes did not change. It lands there as `blocked` rather than `stale`. Same trade
`out.network`'s filters make, and `table.test.ts` pins it so nobody is surprised later.

**Draft now, commit in a moment.** Typing filters the drawing immediately and reaches the param
`COMMIT_DELAY_MS` (140ms) after the last keystroke — Explore's split, for Explore's reason: the
param is in the provenance key, so committing per keystroke is a re-run of everything downstream
between two letters of a cell type.

**Two memos, not one, and the decode is `ValuePreview`'s job.** The sort is keyed on
`[table, sort]` alone: folding it in with the filter re-ran `sortedRowIndices` on every
keystroke, which on 165k rows of a string column is hundreds of milliseconds of `localeCompare`
per character. And the clauses are decoded in a memo keyed on the stored `string[]` — decoded
inline they were a fresh array every store tick, and the viewer resets its draft whenever that
identity changes, so it discarded what was being typed and re-filtered and re-paged on each
tick. Same trap `useStable` was extracted for: **memoise by value.**

**The field lives inside its `<th>`, not in a second row.** `.data-table th` is
`position: sticky; top: 0`, so a second sticky row would need the first one's height as its
offset — a height that varies with whether the column declares a unit. One sticky element that
grows cannot drift. The knock-on is that the column *name* became a `<button>`, which is what
sorts; clicking the field does not. `width: 100%; min-width: 0` on the field is what stops a
filtered column widening as somebody types.

**The controls are `out.table`'s alone.** `TableViewer` draws every table in the app — a Filter
node's own output, a Group By's, an upload's — and only this node has a port for the result, so
`ValuePreview` supplies `filters`/`onFiltersChange` for that one type. Both halves travel
together, or there is a state where the row can be edited and not stored.

**Clauses are stored as JSON pairs, not as a query string.** `parseSearch` reads a field name
only where it matches `FIELD_NAME`, and the columns this viewer draws routinely do not: a wide
pivot names its columns after label values (`LC11_02(R)`) and an uploaded CSV's header can hold
a space. Storing the whole filter as one re-parsed query would lose exactly the columns somebody
is most likely to be filtering. `["Cell Type","~^LC"]` also reads in a `.coda.json` people mail
each other, where a unit-separator join would not.

**The row is toggled from the caption and forced open whenever anything is set**, so an
unfiltered Table card looks exactly as it did before and a filtered one always says why it is
short. The toggle is `disabled` while a filter is live rather than absent — clearing the cells
is what closes the row.

**Both exporters emit real filter code**, since `Filtered` has to bind something or downstream
Python/R refers to a variable nothing assigns. Two disagreements had to be written out rather
than inherited: pandas and dplyr are both **case-sensitive** where Coda lowercases both sides
and carries the `i` flag, and `dplyr::filter` **drops `NA`** where a missing value satisfies
`!=` here. Every mask guards `isna`/`is.na` explicitly, including where the operator would have
got it right anyway — those are the ones that break quietly when edited. The fixture carries a
**second** Table node for the same reason it carries two Select One nodes: the first is fed by
the Pivot, whose wide schema is observed rather than inferred, so no clause on it resolves at
export time and the golden would record only the branch that binds `filtered = out`.

**One pre-existing bug surfaced with it.** The overlay's rail draws each param's label itself
*and* passed no `variant` to `ParamField`, whose checkbox draws its own — so a presentational
boolean rendered `Show filter row / Show filter row`. `out.table`'s filter-row toggle is the
first boolean to reach that rail, which is why it had survived: every other param kind ignores
`showLabel`. The rail now passes `variant="inspector"`, as `ParamRows` already did. Exactly the
double-label trap `SelectOneBody` documents, in the other surface that pairs its own label with
a `ParamField`.

**Verified in a real browser** as well as headlessly, because the header cell's layout is the
class jsdom cannot see: the field sits inside the sticky header (`th` 129–177, field 152–171,
first row starting at 177), column widths do not move as a filter is typed (468/468/481 before
and after), the numeric, regex and invalid cases all behave, and the card shows the row at its
own width with the toggle disabled while filtering. What is *not* covered anywhere is the light
theme, and a table wide enough to scroll the filter row sideways.

## Network + 3D widgets

**Value model.** `Network`, `Skeletons`, `Meshes` and `Points` all pair geometry/topology
with an ordinary Coda **attribute table** (one row per node/item/point, in the same order).
That is the whole trick: column pickers, encodings and future analysis nodes all reuse the
table machinery. `attributeSchema(type, part)` reads that schema off a type, which is why
"colour by [type]" populates on a Network socket exactly as on a Table.

**`BuildNetwork` carries edge attributes, and the merge rule is where the care went.** It used
to emit exactly `source`/`target`/`weight`/`edges`, dropping every other column of the incoming
edge table — which is also why a categorical _link_ colour had almost nothing to bind to.

**`Keep columns` empty means all of them**, not none. That matches the node half of this same
node, which has always taken every joined column, and the `chips` idiom where empty means
"decide for me". Four kinds never ride along: the four names this node owns, plus the source,
target and weight columns themselves, which are already carried under those names.

**Where parallel links merge, a value survives only if every merged row agrees on it** —
whatever its type — and is empty otherwise. A link standing for forty synapse groups across
five ROIs has no single ROI, and naming the first row's would be a confident lie; `edges` says
how many rows are behind it.

**Numbers are deliberately not summed, and this was got wrong first.** Summing is right only
for a measure, and nothing in a dtype separates a measure from an identifier or a code: on a
real male-CNS connectivity table it added `preId` up to 24093454514 — noise, and noise offered
to the numeric pickers where it could have driven a size encoding. `weight` is the one additive
channel; a second additive quantity belongs in a `groupBy` upstream, which names its result
honestly as `sum_x`.

Note the disanalogy that made summing look safe: `nodeSchemaFor` carries everything without a
merge rule because a node join is one row per node. Only edges merge.

`keptEdgeColumns` is called by both `inferOutputs` and `evaluate`, so invariant 3 holds by
construction. And loading does _not_ fill missing params with defaults, so a graph saved before
the param existed has no `keep` key — `resolveColumns` reads that as `[]`, which is why empty
had to mean "all" for those files to gain anything.

The viewer was never the culprit: `out.network` passes the network through and `filterNetwork`
uses `selectRows`, which preserves the schema whole.

**Encodings** live in `ui/encoding.ts` (resolution) and `nodes/lib/encodingParams.ts` (param
factories, headless). Never re-implement colour mapping in a viewer — the 8-slot cap, the
achromatic Other fold, area-scaled sizes and null-as-grey are enforced in one place.
`numeric()` exists because `Number(null)` is `0`, which silently painted missing data as the
ramp's minimum.

**Sequential colour is for area marks, not for hairlines — and that is measured.** Link
colour offers `constant` and `categorical` only. The blue ramp's receding end is **1.46:1**
against the dark surface: correct under a heatmap cell or a node disc, where a low value is
_supposed_ to recede into the page, and invisible on a 0.5px line. Clamping the ramp to clear
the 3:1 non-text floor works — dark reaches 3.23:1 using ramp steps 0–8, light 3.54:1 using
6–12 — but squeezes adjacent steps to ΔL **0.047** dark / **0.035** light against a 0.06 floor,
so it buys visibility with step separation and the validator fails it either way. Link weight
already has an honest channel in `Width`. `ColorParamOptions.modes` is how a caller declines a
mode; if someone re-adds `sequential` for links, `paramGroups.test.ts` is the tripwire.

**Node borders come from `@sigma/node-border`, and two things about it are load-bearing.**
Sigma itself ships only `NodeCircleProgram` and `NodePointProgram`, and a border is what stops
a node dissolving into the links crossing behind it. First, the outline eats _inward_ from the
radius, so `applyStyle` adds the border width back onto the encoded size — without that a
size-4 node loses 44% of its area to a 1px outline and the size legend stops telling the truth.
Second, `createNodeBorderProgram` accepts `drawLabel`/`drawHover`, and sigma prefers a
program's own drawers over the settings: passing them would silently discard the haloed labels
and the selection ring. It is called with neither, and its defaults are `undefined`.

**Alpha rides in the colour, because sigma takes one colour per mark.** `withAlpha` folds a
constant link opacity into `#rrggbbaa`, which sigma's `parseColor` reads. Two consequences
worth knowing: `mixHex` carries an alpha byte through a blend untouched — dimming a translucent
link must not make it opaque — and the SVG export calls `splitAlpha` to write `stroke-opacity`
rather than an eight-digit hex, because an exported file outlives the browser that made it.

**The legend strip keys four channels, and only two of them used to exist on screen.** Node
colour, node size, link colour, link width. Before this the screen drew categorical swatches
and nothing else, while `networkToSvg` had always appended a legend — so a sequential encoding
had no key at all on screen and neither size channel had one anywhere. In `compact` the
identity keys survive and the magnitude ramps stand down: a categorical colour without its key
says nothing, whereas a size ramp annotates a comparison the reader can already make by eye,
and its row costs a tenth of a 150px card.

**Selection is not presentational.** `kind: 'ids'` params are written by viewers, live in the
saved file, and take part in the provenance key. Marking one presentational would let a
stale downstream result survive a selection change.

**The Network viewer filters its own output, and that is the one place it stops being a
tap.** `minLinkWeight`, `topNodes` and `hideIsolated` are **not** presentational: they change
what `evaluate` returns, so they join the provenance key and stale everything downstream. The
alternative — filtering only the drawing — leaves the picture disagreeing with every node
wired after it, which is worse than the cost. `networkOps.ts` holds the logic, headless.

No widget-local preview path exists, and that is deliberate: `out.network` is `cheap`, so the
ordinary 180ms pass already redraws while you drag. Explore's live-widget/debounced-commit
split is for an `expensive` node; copying it here would put a filtered picture beside a stale
downstream graph and have the two disagree, which is the failure being avoided.

**The three filters apply in a fixed order, and the order is the point.** Weight cut, then
top-N ranked _over the links that survived it_, then isolated nodes. Ranking before the cut
answers a different question — "the biggest players in the graph I am looking at" is the
useful one. Ties break on id, because the result reaches a provenance key.

**Filtering recomputes `degreeIn`/`degreeOut`/`weightIn`/`weightOut`.** They are roll-ups
`BuildNetwork` derives from the link set, so a node still claiming `degreeOut: 7` after four of
those links were cut is not merely stale — it is driving a size encoding and a tooltip that
contradict the picture beside them. Only those four names, only when the schema has them; a
network from elsewhere is untouched.

**A tab that changes data has to say so.** `ParamGroup.affectsData` is what widens the panel's
presentational-only admission rule (`paramsForPanel`), and it is also what makes the tab render
its warning. Presentational-only is the promise that makes a styling panel safe to touch;
breaking it silently, so a graph goes stale with no visible cause, is exactly the confusion the
note prevents. The caption carries the other half — `N nodes, M links filtered`, in the same
idiom as `labels thinned`, because a graph that is simply smaller than its data with nothing
saying why is the failure that note already exists to avoid.

**ForceAtlas2 runs in a web worker, and that changed `computeLayout`'s contract.** It used to
return finished positions; for the force layout it now returns only a _seed circle_, and
`startForceLayout` hands the live graph to `graphology-layout-forceatlas2/worker`, which
mutates positions as it settles. Four things about that:

- **Start it after the graph is complete.** The supervisor listens for `nodeAdded`/`edgeAdded`
  and respawns its worker on each one, so starting early restarts the layout once per node.
- **The seed is deliberately not normalised**, unlike every other layout here. Normalising
  would hand FA2 a 1000-unit box when its gravity and scaling were tuned against a 50-unit
  one; sigma's `autoRescale` frames the result regardless, including while it is still moving.
- **Animation is not free, and the worker is only used where it pays.** Each iteration costs a
  postMessage round trip, so 220 iterations is 220 round trips however trivial the graph.
  Measured synchronously at 220 iterations on a 3-regular graph: 100 nodes 18ms, 200 33ms, 400
  122ms, 600 254ms, 800 451ms, 1200 986ms. Below `FORCE_SYNC_BELOW` (600) `computeLayout`
  settles the graph itself and no supervisor starts: there is no convergence worth watching at
  that size, only a wait to sit through.
- **The supervised loop is compute-gated, not frame-gated** — an earlier note here said
  otherwise and was wrong. `handleMessage` applies positions and calls `askForIterations`
  synchronously, so a cycle is one round trip; sigma renders on its own `requestAnimationFrame`
  and never blocks it, and the apply pass is a single bulk `updateEachNodeAttributes` costing
  0.05ms at 3,000 nodes. Per-iteration compute: 1,000 nodes 4.7ms (~213/s), 3,000 14.2ms
  (~70/s), 6,000 20.8ms (~48/s). No single `MS_PER_ITERATION` is right at every size; it is
  calibrated around three thousand nodes and over-delivers below that.
- **`iterations` is a budget, not a count.** The supervisor exposes no counter, so it stops on
  a timer (`settleDuration`), calibrated against the measured per-iteration compute above. It
  was 6ms, which under-delivered against the number asked for. The strip's ⏭ runs the
  remainder synchronously, which blocks;
  that is acceptable only because it takes an explicit press. `skipToSettled` bounds it at ten
  seconds, in batches of a hundred iterations — a backstop against an unbounded graph rather
  than a responsiveness guarantee, and the deadline is checked only between batches, so the
  last one can overrun it.
- **Link weight reaches the layout through the graph's `weight` edge attribute**, and
  graphology's getter coerces a missing one to 1 _without complaint_. That silence is what let
  the worker path ignore synapse counts entirely while the synchronous path used them: the two
  paths build different graphs — `toGraphology` sets `weight`, `NetworkViewer`'s own graph
  originally did not — so the same node laid out with different physics either side of
  `FORCE_SYNC_BELOW`. The viewer's graph now carries `weight` purely for the layout; sigma
  reads `size` for thickness and ignores it.
- **`edgeWeightInfluence` scales attraction only — it never switches weight off.**
  `ewc = pow(w, influence)`, so 0 flattens every edge to 1 for the pull; but
  `graphToByteArrays` accumulates node **mass as the raw weighted degree**, untouched by the
  influence, and mass drives repulsion and gravity. So `Weight pull: 0` means "weight does not
  pull", not "weight is ignored", and the help says so.
- **Kill it, don't stop it,** on unmount: a stopped supervisor keeps its worker alive.

The cost is the layout's determinism, and it is free here: positions are never persisted, and
`layout` is presentational.

**`networkRebuild.test.tsx` is the guard on the two-effect split.** jsdom has no WebGL so the
renderer never exists, but `computeLayout` is awaited in the same `Promise.all` as the sigma
import — so counting calls to it measures exactly how often the _structure_ effect ran. That
is the only handle available without a browser on the most expensive regression this component
has: anything slipping into that dependency list costs a full layout and throws away the user's
framing. Write the test before touching the effect.

**The action strip holds verbs; the styling panel holds settings.** Fit, re-layout, freeze and
find have no value to store, so they cannot be params. Re-layout works by bumping a nonce in
the structure effect's dependency list — heavy, and exactly what "lay it out again" means; the
camera survives because `sameIds` still matches. Find reuses the focus machinery but anchors on
_only_ the matches, with no neighbourhood: a hover asks "what does this touch?", a search asks
"where are these?". A live search owns the focus until the box is cleared, so neither a hover
nor a selection can take it back. Enter is the only thing here that writes to the graph.

**Layered gained a direction and a layer column; `grouped` is new.** Top-down swaps the axes
rather than rotating, so layer spacing stays on the layer axis. `layersFromValues` orders a
numeric column numerically (or 10 sorts before 2) and puts unlabelled nodes in a final layer of
their own rather than in layer zero, where they would read as the first stage. `grouped` rings
the groups by size and rings each group's members inside it, radius growing with √count —
entirely deterministic, no seeding, no relaxation.

**A settled layout survives the viewer closing** (`layoutMemo.ts`). A force layout at a few
thousand nodes is _earned_ — settled over seconds, skipped forward, frozen where it looked
right — and positions used to live in the renderer, which dies with the component. The memo is
module-level rather than a ref for exactly that reason, and it is keyed by the graph node, so
the card, the inspector and the overlay share one layout instead of each settling their own.

Deliberately **not** persisted to the document: positions are not provenance, they would add
two floats per node to every `.coda.json`, and `layout` stays presentational. A memo is reused
only while the node set _and_ a signature of every layout param still match — the re-layout
nonce is in that signature, which is what makes ↻ mean "do it again". **A restored layout does
not restart the supervisor**, since re-settling something somebody worked for is the loss the
memo exists to prevent.

**Spectral layout: eigenvectors of the Laplacian by power iteration on `cI − L`**, since power
iteration finds the largest eigenvalue and the wanted ones are the smallest. Unweighted on
purpose — synaptic weights span orders of magnitude and would let a few strong links dominate
the embedding. It declines rather than guessing when there is nothing to embed: fewer than
three nodes, or no edges at all, where `L` is the zero matrix and the iteration hands back
whatever it started from, which _looks_ non-degenerate to a spread check.

**Spectral seeding for ForceAtlas2 is offered and is not the default**, and that is a finding
rather than a preference. It is a standard technique and it should help; three synthetic
benchmarks each failed to show it, and each turned out to be measuring something else — a
blob's scale, a circulant cluster's own low eigenvalues swamping the between-cluster cut, and
finally index adjacency, which a circle seed satisfies by construction because it lays nodes
out in index order. Defaulting to an unvalidated change is the habit the palette rules exist to
prevent, so the circle stays until a real connectome says otherwise.

**Barnes-Hut is already on where it matters.** `inferSettings` enables it above 2,000 nodes, so
a 3,000-node graph is getting it before anyone asks. Measured at 100 iterations on a 3-regular
graph: 1,000 nodes 425ms → 259ms, 3,000 2656ms → 850ms, 6,000 10710ms → 2013ms. The `Quadtree`
param exists to force it on below the threshold, where it is still worth ~1.6×, or off when
comparing layouts.

**Layouts** are in `ui/viewers/networkLayout.ts`. `assignLayers` is deliberately not a
DAG algorithm — connectomes are full of recurrent loops, so it relaxes with a pass cap
rather than requiring acyclicity.

**`NetworkViewer` runs two effects, and the split is load-bearing.** _Structure_ (graph +
Sigma instance) rebuilds only on new data or a new layout, because building one resets the
camera and re-runs the layout. _Style_ (colours, sizes, labels, arrows, selection) mutates
the existing graph through `updateEach*Attributes` and repaints. Anything that lands in the
structure effect's dependency list by accident costs a full ForceAtlas2 run and throws away
the user's framing.

That is what `useStable` guards: `readColorSpec`/`readSizeSpec` mint a fresh object on every
render of the parent, so identity-keyed memos changed constantly and the renderer was being
rebuilt on every unrelated re-render. Memoise encoding specs **by value**.

It lives in `ui/viewers/useStable.ts` because the scatter plot needs exactly the same thing for
exactly the same reason — there it rebuilt the point set, the hit index and the canvas on every
store tick rather than resetting a camera. A second copy is how two viewers drift on what
"stable" means. `scatterRebuild.test.tsx` is its guard, in the same idiom as
`networkRebuild.test.tsx`: mock the one expensive call and count it.

**Both those files clear their mock in a `beforeEach` with a block body, and that is not
style.** `mockClear()` returns the mock for chaining, so a concise arrow _returns a function_
from the hook — which vitest reads as a teardown callback and duly invokes after every test,
with no arguments. It lands in the real function as `options === undefined` and reads as a bug
in the component under test.

**Reciprocal links bow apart, and both get the _same_ curvature.** The control point is
offset along the perpendicular of (target − source), which flips with the direction of
travel — so equal curvature puts A→B and B→A on opposite sides. Opposite curvatures would
stack them again. `assignCurvatures` in `ui/viewers/networkDraw.ts` owns this, and both the
WebGL path (`@sigma/edge-curve`) and the SVG export read it.

**Export re-draws rather than screenshots.** A WebGL drawing buffer can't be read back after
presentation without `preserveDrawingBuffer`, which taxes every frame. So `networkToSvg`
rebuilds the current view as SVG from sigma's _display_ data (post-reducer, so a focused
selection exports focused) and PNG rasterises that. Two consequences worth keeping: the
export is vector, and it is the only part of this viewer with real test coverage.

**Both viewers are lazy** (`LazyViewers.tsx`). three.js is ~900 kB; it must never enter the
main chunk. Verify with `pnpm build` — `Viewer3D-*.js` should stay a separate file, and
`sigma`, `graphology` and `sigma-edge-curve` should stay in theirs.

**Sigma culls labels three ways at once, and all three had to be dealt with.** A node
smaller than `labelRenderedSizeThreshold` (default 6px) never gets a label — and the default
node size is 4, so out of the box there were _no_ labels until you zoomed in. `labelDensity`
caps labels per 100px grid cell, so panning changes which node wins its cell and labels
blink. And `edgeLabelsToDisplayFromNodes` only draws a link label when **both** endpoints'
labels are already drawn, which made "Link labels" a no-op with node labels off. Fix:
`labelRenderedSizeThreshold: 0`, plus `forceLabel` on every item while the graph is under
`FORCE_NODE_LABELS_BELOW` / `FORCE_EDGE_LABELS_BELOW` — `forceLabel` bypasses all three.
Above the caps the culling returns and the caption says `labels thinned`; don't remove that
note, silent culling is exactly what made the viewer look broken.

**Sigma settings that exist for a reason.** `zoomingRatio: 1.25` + `zoomDuration: 110` (the
defaults animate a 1.7× jump over 250ms and drop any wheel tick inside 50ms of the last,
which on a trackpad reads as lag); `hideLabelsOnMove` only _above_ the force-label cap,
since hiding forced labels mid-gesture just makes them flicker; and `enableEdgeEvents` gated
on edge count because link hover costs a second render pass into a picking texture.

**Two sigma defaults are replaced outright, and one of them was a bug.** Sigma routes every
node carrying `highlighted` through `defaultDrawNodeHover`, whose stock implementation paints a
hardcoded `#FFF` label box with a black drop shadow — so marking a _selection_ lit a white blob
on the `#1a1a19` dark canvas, in a colour belonging to no palette. `makeSelectionRingDrawer`
replaces it with a ring, and three things about that are load-bearing:

- **It fills a disc, not a stroked circle.** Sigma repaints highlighted nodes in WebGL on top
  of the hover canvas, so the node's own colour covers the middle and what survives is a clean
  annulus. A stroke would simply be drawn over.
- **It rings only _selected_ nodes**, though sigma calls it for the hovered one too. Hover
  already reports itself through the focus dimming and the tooltip; a hovered node wearing the
  selection ring reads as having just been selected.
- **The ring is achromatic** (`CHART_INK.primary`). `--accent` is `#2a78d6` / `#3987e5`,
  byte-identical to categorical slot 0, so an accent-coloured ring would be invisible on
  exactly the nodes it marks.

The other replacement is `defaultDrawNodeLabel`, which gains the same halo `networkToSvg` has
always drawn. Until it did, the _exported file_ was more legible than the screen it came from.

**De-emphasis recedes; it never erases.** Dimming blends each mark's own colour towards the
surface, so the context around a focus keeps its structure. Replacing the colour with a flat
`CHART_INK.axis` — which this did — threw the categorical encoding away the instant anything
was selected, and `#383835` on `#1a1a19` is close enough to the background that selecting one
node read as deleting every other. Links recede further than nodes (`DIM_EDGE` > `DIM_NODE`)
because there are far more of them: at equal recession the dimmed mat is still a hairball.

**Focus is an ego network, anchored on the hover or else the selection.** A link is lit only
when it _touches an anchor_, not merely when both its ends are focused — otherwise hovering a
hub redraws that whole neighbourhood's internal structure, which is the thing being cut
through. Hover overrides the selection's focus rather than compounding with it, and hands it
back on leave; a hover is a momentary "show me this instead".

**`.viewer` must stay `position: relative`.** Both viewer overlays — the "laying out…" note
and the link tooltip — are positioned from the renderer's _container_ coordinates. Without a
containing block on `.viewer` they anchor to whatever distant ancestor happens to be
positioned (the node card, the overlay panel) and land nowhere near the pointer.

**No visual verification exists for these two.** jsdom has no WebGL, so sigma and three
cannot render in tests, and there is no browser automation here. Everything testable is
tested headlessly (layouts, encodings, geometry generation, node semantics); the actual
pixels have not been seen by anyone yet.

## Scatter plot

`out.scatter`, `Add ▸ Visualisation ▸ Scatter Plot`. seaborn's `scatterplot` — x, y and the
three encoding channels hue, size and style — plus what this data needs on top: log axes, a
linear fit, and a lasso that hands the enclosed neurons back to the graph. `Table → Scatter`
passes the table through and emits `Selected`, so it is a tap like every other viewer here.

**Canvas rather than SVG, and that follows from what it is for.** The `Embedding` node in the
TODO list feeds this one, and an embedding is of a _whole dataset_ — male-CNS is 165,122
traced neurons. One `<circle>` per row is a hundred and sixty thousand DOM elements. Export
re-draws the same spec as vector (`scatterDraw.ts`), so what is given up is the DOM and not
the vector file. Same doctrine as `networkToSvg`, arrived at from the same constraint.

**Everything geometric is in `scatterPlot.ts`, headless, and that is not tidiness.** jsdom has
no canvas, so anything left in `ScatterViewer.tsx` is covered by nothing at all — the same
standing `networkLayout.ts` and `networkDraw.ts` have. Scales, ticks, the point budget,
projection, hit testing, lasso containment and the least-squares fit all live there.

**Two coordinate spaces, and mixing them is the trap.** _Value space_ is what is in the
column and what a tooltip prints; _transformed space_ is that under the axis scale, i.e.
`log10(value)` on a log axis. Domains, ticks, the viewport and the trend fit are all
transformed, because that is the space the picture is linear in. `forward`/`inverse` are the
only crossings and everything named `*T` is transformed.

**`Max points` thins the drawing and nothing else — so it is presentational, and the Network
viewer's filters are not.** That contrast is the whole of it. `out` is the input table
unchanged, and a lasso is tested against **every usable row rather than the drawn sample**, so
no output can tell whether a point was painted. `out.network`'s `minLinkWeight`/`topNodes`
genuinely subtract from what it returns, which is why they stale everything downstream and
carry an `affectsData` tab. Getting this backwards would have a graph go stale every time
somebody raised a drawing cap, which reads as a scheduler bug.

The sample is a **deterministic stride**, not a random draw: a random one reshuffles per
render, so points would flicker in and out during a pan and the picture would never be the
same twice. The caption says `showing 50,000 of 165,122`, in the same idiom as
`labels thinned`.

**Selection is by id, with the row index as an admitted fallback.** `nodes/lib/rowIds.ts` owns
it and _both_ the viewer and the node import it — what a selected point is called has to mean
the same thing to the code writing the ids and the code resolving them, and two agreeing
implementations drift the first time either is touched. `idColumn` defaults to `neuronId`
through `optional: true`, which is what makes the resolver answer "nothing" rather than
reaching for the first column when the table has none. The fallback exists because the tables
least likely to carry an id — an uploaded CSV of embeddings, a `groupBy` roll-up — are exactly
the ones a scatter is for, and a dead lasso there is worse than a fragile selection the caption
labels `by row index`.

`idColumn` is therefore **not presentational**, alongside `selection`. It decides which rows
`Selected` carries; marking it presentational would let a stale downstream result survive a
change to the very thing identifying the rows. Those two are also the only params outside the
tabbed panel, which is what keeps every tab's presentational-only promise true without an
`affectsData` warning anywhere.

**Reading a cell refuses what `Number()` accepts.** `Number(null)` and `Number('')` are both
0, so a plain conversion draws a dense stripe of data that does not exist along each axis.
Same trap `numeric()` in `encoding.ts` exists for, same answer. Rows that cannot be placed are
**counted and reported** (`N unplottable`) rather than silently absent — which matters most
for the log axes, since nothing about flipping a switch suggests values at or below zero would
leave the picture.

**Shape follows the colour rules exactly, because it is the same kind of channel.** Ranked by
frequency, capped, and the tail folded into one residual mark rather than reusing one — a
repeated mark implies two categories are the same thing, which is why the palette never cycles
a ninth hue either. Six marks rather than eight: shape is coarser than hue at the size a point
is drawn, and a seventh that reads as "a slightly different blob" is worse than an honest fold.
Marks are **area-matched** (`SQUARE = √π/2`), or a square at the circle's radius would be 27%
larger and shape would start encoding magnitude by accident.

**Gestures match the canvas underneath.** Bare drag pans, Shift-drag lassos, ⌘/Ctrl-drag boxes
— the same assignment `panOnDrag` and `selectionKeyCode="Shift"` give the editor, so the hand
does not change modes when the pointer crosses into a card. Navigation is far more frequent
than selection and gets the bare gesture. Below `CLICK_SLOP` a drag is read as a click: a plain
one selects the point under it or clears, a modified one toggles. The marquee is an SVG overlay
rather than part of the repaint — a gesture that redrew fifty thousand marks per pointer move
is not a gesture.

The wheel handler is a **native listener with `passive: false`**. React routes `onWheel`
through a passive root listener, so `preventDefault` there is ignored and the page scrolls
behind the chart; `nowheel` on the wrapper is the other half, stopping React Flow zooming the
canvas underneath.

**Framing resets on a new question and never on a resize.** The viewport is cleared when the
table or either column or scale changes, because a zoom framed on one pair of columns says
nothing about the next — but a resize changes how much fits, not which picture it is, and
throwing away a zoom because somebody dragged the card's corner is the loss the layout memo
exists to prevent. `equal` aspect is re-imposed after a resize instead, and it **widens the
tighter axis, never narrows the looser one**: narrowing would push data outside the plot, and
an aspect setting that hides points is not an aspect setting.

**The trend fits in transformed space, and per _resolved colour_.** Transformed, so the line is
straight on screen — which makes a log-log fit a power law and a semi-log fit an exponential,
the reading anyone puts a log axis on to get. Grouped by the colour rather than the raw column
value, so each line corresponds exactly to a legend entry: the eight-slot cap and the
achromatic `Other` fold have already happened, so a ninth category's line is drawn for the
bucket the legend actually names. A constant colour therefore collapses to one line by
construction. It declines rather than drawing through fewer than two points or a vertical
cloud — a line through one point is a claim about a relationship nobody observed.

**Ticks needed a second implementation, and that is not duplication.** `niceTicks` in
`format.ts` always starts at zero because a bar chart's baseline does; a scatter's window
routinely excludes zero and always does after a zoom. `axisTicks` covers an arbitrary domain,
and subdivides a narrow log window into 1/2/5 rather than showing two labels a decade apart.

**Marks are batched by `colour|shape`, one fill per bucket.** With a categorical encoding that
is at most nine buckets for any number of points, which is the difference between a redraw
that keeps up with a pan and one that does not. A sequential ramp defeats it by construction —
every value is its own colour — and is left to, rather than quantised: quantising would put a
colour on screen that `resolveColor` never returned.

**`LegendKeys.tsx` was extracted from `NetworkLegend`, not copied.** Two viewers drawing their
own swatches is how two viewers end up disagreeing about what the palette's `Other` bucket
looks like. `ShapeKey` draws the marks through the same `markPath` the plot does, because a
legend that approximated its own marks would be the one place on screen where what is drawn
and what it says may differ — and shape is the fallback channel for exactly the readers a
colour key cannot serve.

**The axes open on named defaults**, `pre` and `post`, rather than empty ones. An empty default
means "the first compatible column", which is the _same_ answer for both axes — so a node
dropped on a neuron table would open drawing a column against itself, a diagonal that looks
like a broken viewer. `resolveColumn` falls back to the first numeric column wherever those
names are absent, so nothing is worse off.

**`evaluate` never refuses over an unpicked column**, and the reason is worth keeping. `out` is
the input unchanged, so throwing because a _drawing_ cannot be configured blocks every node
downstream for a reason that has nothing to do with them — and on the graph that exposed it,
`Pivot → Scatter` reloaded from a file, it was not even true: the pivot publishes no schema
until it has run, so the first Run errored `no numeric columns` while holding a table whose
numeric column the message listed. Passing through lets the run finish, after which the store
re-infers against the schema the pivot has now published and the widget draws — no second Run.
`validate` says nothing at all while the incoming schema is unknown, and the widget's empty
state distinguishes _not known yet_ from _nothing to pick_. See invariant 5's corollary.

**No visual verification exists.** jsdom has no canvas beyond the accept-everything stub, so
the marks have not been looked at by anyone; what is checked is the geometry, the exported SVG
and the caption. Same standing as the WebGL viewers.

## Heatmap: more cells than pixels

`out.heatmap` used to refuse above **20,000 cells**, and that number was a fact about SVG rather
than about matrices: every cell was a `<g>` wrapping a `<rect>` carrying its own `onMouseMove`
and `onMouseLeave`, so the cap was really 40,000 DOM nodes and as many listeners on one card. It
landed on exactly the pictures this viewer exists for — an NBLAST score matrix at the Skeletons
node's own 500-neuron ceiling is 250,000 cells, and `Linkage → Ordered → Heatmap` is *meant* to
be read at that size, where the structure is texture rather than cells. The ceiling is now
**4,000,000**, which is above `MAX_PIVOT_CELLS`, so the viewer draws anything a Pivot will build.

`heatmapPlot.ts` is the headless half — geometry, the fold, the hit test — and `heatmapDraw.ts`
is the canvas pass and the standalone SVG, both reading one spec. `scatterPlot`/`scatterDraw`'s
arrangement, for its reasons: jsdom has no canvas, so anything left in the component is covered
by nothing, and one spec is what makes the exported file the picture on screen.

### The fold is the whole of it

**A cell smaller than a pixel is not drawn.** The matrix is folded onto a grid of at most one
cell per CSS pixel of the plot, and the canvas pass, the SVG export and the hit test all work on
that grid — so **drawing costs the card rather than the data**. Only the two passes that cannot
be bounded stay O(n): the extent scan and the fold itself. Measured in a browser at 1400×700,
spec build then first paint: 90,000 cells 1.2/5.6 ms, 250,000 3.2/17 ms, 1,000,000 11/37 ms,
4,000,000 20/46 ms. So the ceiling costs about 65 ms of one frame, on a resize or a theme flip
and never on a hover.

**CSS pixels, not device pixels**, so the picture does not change between a retina screen and a
projector, and the exported SVG — which draws the same grid — is the same file whoever exported
it. What is given up is the sub-CSS-pixel detail a 2× screen could have shown.

**A block keeps its strongest cell, never the mean.** A connectivity matrix is sparse, and
averaging one strong connection across the hundred empty cells beside it puts it at a fraction of
a percent of the ramp — off the picture, which is the only thing in it. Strength is measured from
the scale's own neutral end (the low end for sequential, zero for diverging), so a diverging fold
keeps both tails rather than only the positive one, and a sequential fold keeps the largest value
rather than the largest magnitude. Same brightest-wins rule as `raster.ts`.

**The winning cell's index is kept**, so the tooltip over a folded block names a real row, column
and value — and says `strongest of ~N cells` beside it. That admission is on the *card* as well
as in the overlay, which matters, because the caption's `cells merged` note stands down under
`compact` as every viewer note here does. A folded picture that said nothing anywhere would be
the failure `labels thinned` already exists to prevent.

### Canvas for the cells, SVG for everything else

This is the one place the viewer departs from `ScatterViewer`'s all-canvas call, and the
arithmetic licenses it rather than taste. A scatter's tick labels are a handful either way; a
heatmap's axis labels are bounded by **pixels**, since only so many 10px names fit down an edge
however large the matrix is. So the labels, the printed cell values and the hover outline stay in
an SVG overlay: real text that can be selected, found and read aloud, laid out by the browser
rather than by `measureText` — and a hover that costs one element rather than a repaint of four
million cells. `.heatmap-overlay` is `pointer-events: none`, or a label would put a dead strip
across the row it names.

Axis labels are **thinned to a legible pitch and the drop is counted**, which the old code never
had to do because it never drew a matrix taller than its own labels.

### The chrome is shared, not drawn twice

The cells were shared from the start (`cornersByBucket`), and the labels and printed values were
not — two independent drawings carrying the same magic numbers, and they **had already parted
company** after one afternoon: a cell whose bucket is `-1` took ramp-bottom ink on screen and
black in the file. `axisMarks`/`valueMarks` in `heatmapPlot.ts` now return placed, coloured
`TextMark`s that the overlay maps to JSX and the exporter to `<text>`, so the file matches the
card for the chrome as well as for the cells.

**A `TextMark` carries its baseline, and absent means alphabetic.** `dominant-baseline: central`
centres text across its *reading* direction, so on a column label turned -90° it moves the label
sideways by half a cap height and the whole band drifts off the columns it names. Applying it
uniformly is the obvious tidy-up and it is wrong; it was caught by pixel-diffing against the
previous build, since jsdom performs no layout and nothing else here can see a two-pixel move.
`heatmapPlot.test.ts` pins the row/column distinction.

### Two things measured rather than assumed

- **The ramp is a 512-entry lookup table, and that is not the quantisation `ScatterViewer`
  refuses.** That viewer declines to quantise a sequential ramp — "quantising would put a colour
  on screen that `resolveColor` never returned" — so this was checked over 200,000 samples of
  both scales in both modes. The ramps are piecewise-linear in RGB and the output is 8 bits a
  channel, so the whole blue ramp is **453 distinct colours** and the diverging scale 621–1,006;
  against those, 512 steps is within **one** channel value of exact for sequential and **two** for
  diverging, and 256 measures the same. The scatter's objection is real for a *categorical*
  palette, where a substituted slot means a different category; here a colour is a magnitude and
  the substitute is the same magnitude to within a rounding step. Without the table, 285,000
  `sequentialColor` calls cost **65 ms against 2 ms**, per render.
- **Cells are batched by ramp bucket, and carried as flat corners.** One path and one fill per
  bucket, so a bounded number of fills for any number of cells — the scatter's colour+shape
  batching arrived at from the other direction, since there the sequential ramp defeats the
  batching and here the ramp *is* the batching. Every cell is the same size, so only `x, y` is
  stored per cell and the width and height are read off the spec once: that alone took a
  four-million-cell repaint from **77 ms to 46 ms**, most of the difference being garbage no
  longer made.

`buckets` is **mode-independent** by construction, so a theme flip re-resolves the ramp's hex and
repaints rather than re-folding the matrix — and `cornersByBucket` is memoised against the spec in
a `WeakMap` (`rowFields.ts`'s `slotCache` idiom), so that repaint does not re-walk 900,000 grid
cells to change nothing but 512 `fillStyle` strings. Measured, it took the four-million-cell
repaint from 46 ms to 27 ms and made an export cost no third walk.

**`Show values` is applied at render, never in the fold.** It reached `buildHeatmapSpec` only to
decide one boolean, which put it in the dependency list of a pass that walks every cell — so
toggling it on a four-million-cell matrix re-scanned the whole thing to compute `false`.
`labelsFit` is now the size test alone and the param is `&&`-ed in beside it.

### The export

`svg: () => heatmapToSvg(...)` rather than the live element, because the live element no longer
holds the cells. **A folded picture exports folded** — the cells below a pixel were not on screen,
so drawing them would be a document claiming detail nobody saw, and one rect per cell of a
four-million-cell matrix is a file nothing opens. Bucket-batched there too: a 356×356 matrix
exports as 54 `<path>` elements carrying 82,236 subpaths, 2.0 MB, and parses clean.

**Two pre-existing bugs in the shared export path had to be fixed to get there**, and both are
the same shape: two owners for one declaration.

`serializeSvg` set the namespace with `setAttribute('xmlns', …)`, which creates an ordinary
attribute in the *null* namespace that merely happens to be spelled `xmlns` — so `XMLSerializer`
emitted it beside the declaration it already writes for an element created in the SVG namespace,
and **every chart this app exported carried `xmlns` twice**. A duplicate attribute is a fatal XML
well-formedness error rather than something a reader recovers from, and SVG is parsed as XML:
`DOMParser` returns a `parsererror` document for it. It affected the bar chart, the scatter, the
network and the dendrogram alike, and it failed to *parse* rather than looking slightly wrong,
which is why nothing about the string ever caught it.

And `serializeSvg` appended a `<style>` inlining the font **unconditionally**, beside the one each
builder already appends — measured on a real export: two style blocks, the serializer's saying
`sans-serif`, because `getComputedStyle` on a *detached* element resolves nothing and a
synthesised export is always detached. Only document order saved it: `insertBefore` happened to
put the dead declaration first. Moving that to an append, or a builder dropping its own, would
have silently stripped the typeface from every exported chart.

**The fix is structural rather than advisory, which is the point.** `setAttributeNS` makes the
namespace a real declaration so exactly one is written, the font is inlined only when the element
carries none, and `svgElement.ts`'s **`svgRoot()` has no parameter for `xmlns` or `font` at all** —
so a fourth builder cannot reintroduce either by copying a third. The first pass fixed this with
three identical comments saying "do not set xmlns", which was verified to be worthless:
re-adding the attribute to `networkToSvg` left all 43 builder tests green, because
`networkDraw.test.ts` asserts `toContain('xmlns="…"')` and that passes just as happily when it is
written twice. `svgBuilders.test.ts` is the tripwire under it — every builder's output through the
real `serializeSvg` and a real XML parse — and both halves were confirmed by mutation.

### What was checked in a real browser

Headless Chrome over CDP against `pnpm dev`, because this is the class jsdom cannot see.

- **The small case is unchanged.** The bundled matrix example rendered before and after and
  pixel-diffed: **cell interiors byte-identical**, and the only differences are the two output
  pixels the 1px separator straddles, where the canvas and SVG rasterisers weight a sub-pixel
  edge differently by 1–11 values. 3.6% of the frame, all of it on the separator lines. The same
  diff was re-run after the shared-chrome refactor and came back at **zero** differing pixels,
  which is how the baseline regression above was found.
- A 356 × 356 adjacency (126,736 cells) drawn on a card and expanded, against the old build
  answering `205 × 356 is too large to draw (72,980 cells)` on the same graph.
- The tooltip on a folded card, saying `strongest of ~2 cells` and landing under the pointer.
- The SVG export captured off `URL.createObjectURL` and re-parsed in the page: no `parsererror`,
  one `xmlns`, 54 paths, labels present.
- **Light theme, loaded fresh**: labels `#52514e`, the low end resolving to `#cde2fb` and the
  surface to `#fcfcfb` — all through `currentMode()`, so a viewer computing hex in JS survives.

**A live theme switch does not repaint this viewer, and that is pre-existing** — checked against
the old build, which left its labels `#ffffff` and its cells `#134789` on a light card in exactly
the same way. `currentMode()` is read during render and nothing re-renders the card on a theme
change; any subsequent edit fixes it. Not introduced here and not fixed here, because it is one
symptom of something several viewers share.

**+6.7 kB raw / +2.5 kB gzipped on the main chunk** (1,002.41 → 1,009.11 kB), measured against a
build of the same tree with the feature absent. Far under this codebase's bar for a lazy boundary.

Three things were lifted out rather than copied a third time, on the second-consumer rule this
codebase states repeatedly (`useStable`, `LegendKeys`, `Tiles`, `raster`): `svgElement.ts` holds
`SVG_NS`, `round`, `element`, `textNode` and `svgRoot` for all three SVG builders; `canvas2d.ts`
holds the HiDPI setup the scatter and the heatmap share — and it now skips the `canvas.width`
write when the size is unchanged, which was reallocating a ~16 MB backing store on every theme
flip; and `labelStep` moved from `dendrogramLayout.ts` to `format.ts` beside `truncateLabel`,
because two thinning rules that round differently drop different numbers of labels under captions
that both say `labels thinned`.

What has **not** been looked at is a matrix at the four-million ceiling in a browser — the mock
connectome tops out at 401 neurons, so the ceiling's cost is measured against synthetic data
through the real functions rather than through a real graph.

## Neuroglancer

`out.neuroglancer` emits a **URL** and the widget is an iframe on it. There is no SDK and no
bundled copy of neuroglancer; the entire integration is `src/data/neuroglancer/scene.ts`
(headless, source-agnostic — FlyWire and CAVE publish states too) plus one endpoint call in
`neuprint/nglayers.ts`.

**A published scene is edited, never rebuilt.** The camera, the EM volume, the ROI meshes and
the synapse layer wired to the segmentation are the reason to reuse it. Verified shapes,
because they are not uniform and the differences are load-bearing:

| dataset            | what it publishes                                                              |
| ------------------ | ------------------------------------------------------------------------------ |
| `hemibrain:v1.2.1` | `{ layers }` and nothing else — no dimensions, position or layout              |
| `hemibrain:v1.1`   | `{ layers, badlayers }`; `badlayers` is Explorer bookkeeping, not viewer state |
| `manc:v1.2.3`      | full state, `layout: "3d"`, and a stray `segmentColors` for one body           |
| `male-cns:v0.9`    | full state, 38 layers, 38 kB before a single neuron id is added                  |

So the module supplies `layout` and `showSlices` when absent — neuroglancer's own defaults
open hemibrain in 4-panel with EM planes cutting through the neurons — clears manc's stray
colour rather than merging into it, and strips `badlayers`.

**Two published defaults are overridden, not offered as options.** `showAxisLines` goes to
false — the lines cross the middle of the volume and read as anatomy at a glance — and
`selectedLayer.visible` goes to false, keeping the panel's `flex`/`size`/`layer`. MANC and
male-CNS both publish it open, which costs about 70% of a card that is already far smaller
than the browser window those states were framed for. Neither key is in `SCENE_PATCH_KEYS`,
and that is deliberate: they are _opening_ defaults, so a later merge does not slam shut a
panel the user has since opened. Note that neuroglancer drops `visible` from its own
serialisation once it is false, since that is its default — so a round-trip will not show it.

**Find the neuron layer by name, not by type.** male-CNS ships thirty segmentation layers:
ROI shells, nuclei, cross-dataset mesh overlays. Writing neuron ids into `brain-shell` renders
nothing with nothing to blame. Same family-name rule as `meshSourceFromState`.

**This is the one node with no presentational params, and that is the invariant.** Its output
_is_ the styled artefact — the colours are inside the URL — so marking a colour param
presentational would leave the node `ok` while its link still carried the old palette. That
is why `colorParams` grew a `presentational` opt-out; do not use it anywhere else.

**It imports `resolveColor` from `src/ui`** — the only `nodes → ui` edge in the tree. That is
deliberate: "never re-implement colour mapping" applies to an external viewer too, and
reusing it is what makes a neuron the same colour in the 3D view and in neuroglancer. Both
modules are pure, so it stays testable headlessly. Colours resolve in `'dark'` regardless of
Coda's theme, because neuroglancer renders on black.

**`cheap`, despite fetching**, because the fetch is one small JSON per dataset that
`NeuPrintSource` caches — the failure included, since a `cheap` node re-runs on every
restyle. Everything after that is string building.

**The frame is mounted in the node body, not only in the overlay.** That is a real cost —
each one is a full WebGL application that starts fetching EM on mount, and a canvas can hold
a dozen — and it is paid deliberately, because a viewer you have to open before anything
appears is not an exploration surface. The escapes are the resize handles and the ordinary
collapse toggle, which unmounts the preview.

**`uiScale` is the one presentational param, and it marks the line.** Everything else reaches
the URL, so it belongs in the provenance key; scaling the _frame_ cannot change a byte of what
`evaluate` returns. The frame is laid out at `1/scale` and drawn at `scale`, so it fills the
card exactly while neuroglancer believes it has a larger viewport — which is what makes its
chrome take a smaller share. A `transform` rather than the `zoom` property: it composites
instead of relaying out, and pointer coordinates into an iframe map through it correctly. Not
called "zoom" on purpose, since neuroglancer has a camera zoom and two of those on one card is
a trap.

**Every param is `advanced`, i.e. inspector-only.** A row of pickers above a 400px embed
takes a tenth of the space someone opened the node for. The inspector shows the full set for
the selected node, which is where a control that rebuilds a scene belongs. Note the
consequence: these params are _not_ presentational, so they never appear in the overlay's
rail either — the inspector is the only place they live.

**Colour mode `default` sends nothing at all** and lets neuroglancer hash-colour each
segment, and it is **this node's default**. Distinct from `constant`, which sends one
`segmentDefaultColor`; the point is that no colour data travels, which is also the shortest
link — and this is the one node whose entire output is a URL somebody pastes into mail.

It is the right default rather than merely the cheapest, and the reason is the palette's own
rule: Coda caps a categorical encoding at eight slots and folds everything past them into one
achromatic bucket, because in a legend a repeated hue claims two series are the same thing. A
scene has no legend, and past the eighth cell type every remaining neuron would be the same
grey. Neuroglancer gives every segment a distinct colour and needs no legend to do it.
`defaultColumn: 'type'` is still there for the moment somebody picks a data-driven mode —
`neuronId` is the first compatible column and is the wrong answer for the same eight-slot
reason.

`colorParams` only offers the mode when a caller opts in with `allowDefault`, because no in-app
viewer can honour it — `resolveColor` degrades it to the flat colour so it is harmless if it
ever leaks.

**Updates go through neuroglancer's `#!+` merge form, and this is the load-bearing part.**
The plain `#!` form makes neuroglancer `reset()` before restoring, so every upstream edit threw
away the camera, the layout and every runtime tweak — change a filter three nodes away and the
framing you had just set up was gone. `#!+` restores _over_ the live state: keys it does not
mention keep their current values. So `scenePatchUrl` sends only `SCENE_PATCH_KEYS` — the three
things this app owns — and the camera survives.

Four facts behind that, all established against the deployed viewer rather than reasoned:

1. **Assigning `src` a URL differing only in fragment does not reload the document.** It is a
   same-document fragment navigation; neuroglancer keeps its meshes and handles `hashchange`.
2. **The iframe element's `load` event fires on fragment navigations too**, so a load counter
   in the parent reports a reload that did not happen. That measurement said the opposite of
   the truth for a while. Only a signal from inside the frame distinguishes them.
3. **`layers` must be the whole list in a patch.** The merge is per top-level key, not per
   layer: a patch naming only the segmentation layer deletes the EM volume and every ROI mesh.
4. **Per-layer runtime state cannot survive**, precisely because of (3) — a visibility toggle
   or a randomised colour seed is rebuilt from what we send. That is the limit of what an
   iframe allows; reading the live state back would need a same-origin frame.

**`SCENE_PATCH_KEYS` is one key, and shrinking it was a bug fix.** It held
`['layers', 'layout', 'showSlices']` until neuroglancer was reported erroring under rapid
updates: a cascade of `can't access property "generation" of undefined` ending in
`Error restoring property "layout"` — which names the key. Restoring `layers` tears down and
rebuilds every layer; restoring `layout` in the same pass rebuilds the panels holding
references to them, and doing both while someone is dragging is asking the two to race.
Sending only `layers` takes the named property out of the update path. The cost is that
`layout` and `showSlices` fall into `sceneIdentity`, so changing either re-navigates and the
camera returns to the published framing — right trade, since they are structural and rare
while selection changes are constant.

**Where the viewer is proxied same-origin, updates are _spliced_ rather than merged.** This is
the answer to "why can't we just change the segments and leave everything else alone": a merge's
finest granularity is a top-level key, `layers` is one key, and restoring it replaces the whole
list — so a merge sends _our_ layer list and takes with it any layer the user hid, added or
reordered. Verified in both the array and the name-keyed map forms; neither reconciles per layer.

The way round it is to stop sending our list. `spliceSegments` reads what the frame is currently
showing, writes only that one layer's `segments`/`segmentColors`/`segmentDefaultColor` into it,
and sends _that_ back — so the list written already contains everything the user did. Reading
`location.hash` needs same-origin, which is the only reason `/ng` exists in `vite.config.ts`;
neuroglancer frames fine cross-origin. Without the proxy the embed still works and falls back to
merging, so a static deploy loses the preservation, not the viewer.

Note the split: the **frame** goes to the proxied path, the **link** stays the absolute public
URL. A copyable link that pointed at `/ng` on someone's dev server would be useless.

**Merges are debounced** (`MERGE_DEBOUNCE_MS`), trailing-edge, and only merges — the first
navigation is immediate. Auto-run turns one upstream edit into a scene per keystroke, and
applying each had neuroglancer rebuilding its layers several times a second. Only the last of
a burst is worth anything.

Worth knowing for the next person who chases this: it did not reproduce in Chrome or in
headless Firefox (no WebGL there, so the render paths that touch `generation` never run). The
fix is reasoned from the error text, not from a repro.

A full navigation returns when `sceneIdentity` changes — everything outside the patch keys,
i.e. a different dataset or viewer. Merging across those would keep a camera framed on the old
volume, leaving you in empty space beside the one you asked for. The component also refuses to
merge before the frame's first `load`, or a selection changed during the second neuroglancer
takes to boot would merge onto its defaults.

**The Neurons port is `required: false`, and the empty cases do not throw.** A dataset alone
resolves to the published scene with no segments, which is a perfectly good thing to look at
— and an empty _table_ means the same thing, because that is what an untouched Explore
selection is and what a starter graph opens in. Only a port wired to something that is not a
table is an error. Getting this wrong turned the node into a dead card until someone had
ticked a neuron, which is the opposite of an exploration surface.

No `Selected` output, and there never will be one through an iframe: a foreign-origin frame
cannot be read. Picking neurons stays upstream.

## neuPrint

Lives entirely under `src/data/neuprint/`. Nodes see the same `DataSource` interface the
mock implements; nothing above `src/data` knows Cypher exists.

**Direct access depends on the deployment, so the route is discovered rather than declared.**
neuPrint used to send _no_ `Access-Control-*` headers on any response, with its `OPTIONS`
preflight returning 401 before CORS middleware would run — so a request carrying an
`Authorization` header was blocked by the browser before it was sent, and every call had to go
through a same-origin proxy. Janelia has since fixed that on `neuprint-test.janelia.org`, and
the fix was checked end to end rather than taken on trust: 204 on the preflight,
`Allow-Headers: Authorization, Content-Type` (exactly what this app sends — `Accept` is
safelisted and needs no mention), no `Allow-Credentials`, and `Access-Control-Allow-Origin` on
**every** response including 401 and 404. That last one is the load-bearing part: the
`reportAuthFailure` channel works by reading a 401's status, which a browser only surfaces if
the response itself carries ACAO. All seven endpoints this app calls were verified, each path
prefix preflighted separately (nginx CORS config is per-location), and a 4 MB Explore-shaped
index came back gzipped to 957 kB in 1.4 s. `neuprint.janelia.org` does **not** have it yet.

So `routesForServer` offers two routes — the deployment itself, then the proxy path — and
`client.ts` _tries_ them, because a browser reports a CORS refusal as an opaque `TypeError`
indistinguishable from a dead host. The answer is remembered per deployment in `localStorage`,
since without that every request in a proxy-only session pays a failed preflight first. Three
rules make that safe, and each is pinned by a mutation-checked test:

- **Only a thrown fetch moves on to the next route.** A response of any status means the
  request arrived, so a 404 is neuPrint saying 404. Retrying a _status_ would also send a
  second copy of a POST — and that endpoint runs Cypher. Same rule as `transport.ts`.
- **Only a 2xx is remembered.** A 404 is what a static host answers for a proxy path nobody
  serves; remembering it would pin a deployment to a route that can never work, and would
  outlive the day that deployment gains CORS.
- **An `AbortError` is never answered by trying elsewhere** — that would issue the request the
  cancellation was meant to stop.

The proxy still matters and is registered under **both `server.proxy` and `preview.proxy`** —
those are separate config keys, and a preview server without it 404s every request with an
empty body.

**A 404 on a same-origin base means "no proxy", not "neuPrint said no" — and it takes two
tells, not one.** neuPrint's own errors always carry a JSON body, so an _empty_ body is the
tell for a vite server with no matching rule. A static host is the other case and answers
differently: GitHub Pages serves its own 9 kB HTML 404 page. Checking only for the empty body
is how a Pages deploy came to report `neuPrint returned 404: <!DOCTYPE html>…`, blaming a
server that never saw the request and sending somebody to look at their token. `looksLikeHtml`
is the second tell. Do not collapse either back into a generic message — the first cost a
debugging round trip already, and the second cost one in the deployed app.

**The app introduces itself in a Cypher comment, because nothing else is available.** neuPrint
is a shared production Neo4j and an operator reading a slow-query log cannot otherwise tell which
client sent what. A browser cannot help the way neuprint-python does: `User-Agent` is a forbidden
header name in the Fetch spec, so it is silently ignored and Coda sends the browser's. A custom
header is the obvious substitute and is currently **worse than nothing** — it is not
CORS-safelisted, so it must appear in `Access-Control-Allow-Headers`, and neuPrint answers a
preflight with a **fixed** `Authorization, Content-Type` whatever is requested (checked with
three different `Access-Control-Request-Headers`). Adding one today would fail every
cross-origin request outright rather than merely going unnoticed. It is a line of nginx config
on Janelia's side; ask for it alongside the production CORS rollout, since it is the same file.

So `tagQuery` prefixes `// coda/<version>`, which reaches the query log and changes nothing that
executes. Three things about it:

- **It lives in `client.ts`'s `runCypher`, not in `cypher.ts`'s builders.** One place covers
  every query including the Raw Cypher node's, which no builder sees — and the builders are
  asserted against exact query text throughout `neuprint.test.ts`, so tagging there would thread
  a version through several dozen assertions that are about escaping and column order.
- **It costs no provenance.** A cache key is `hash(type, params, upstream keys)` and never the
  query text, so a version bump changes no key and invalidates nobody's results.
- **It was checked against the live deployment rather than assumed.** neuPrint validates that a
  query is read-only and a leading comment could plausibly have upset that; six shapes were run
  against `neuprint-test` — plain `MATCH`, `WHERE … IN`, a `WITH` pipeline, a bare `RETURN`, a
  `CALL`, and a query that already carries its own comment. All accepted, and neuPrint echoes
  the whole query back in a `debug` field, which is where it becomes visible.

**Per-dataset schemas.** `DataSource.schemasFor(datasetId)` is optional and synchronous;
`schemasFromType()` in `datasetParam.ts` is the single funnel every query node goes through,
so this is the only place that had to change. hemibrain has `cellBodyFiber` and `somaRadius`,
manc has `hemilineage`; one fixed schema would either lie or under-report. Discovery reads
`Meta.neuronProperties` where it exists (**hemibrain has none**) and otherwise samples whole
neurons with `RETURN n`, which yields names _and_ value types in one round trip. Two things
get subtracted: ROI names (a neuron carries a boolean per innervated ROI — 230 of them on
hemibrain, and `IB`/`INP` look nothing like ROIs) and non-scalar properties (manc declares
five as `point{srid:9157}`).

**Everything is inlined into the query string.** `/api/custom/custom` takes no parameter
map, so values must go through `escapeString` / `idList` / `escapeIdentifier` in
`cypher.ts`. Nothing else may build a literal.

**Column mapping is positional.** neuPrint names columns after the expression (`n.bodyId`),
so the decoder matches `RETURN` order against schema order and throws on a count mismatch.
If you add a column to one, add it to the other — the builder and its schema are written
together for this reason. It is also what lets Coda's column name differ from neuPrint's
property name without a lookup per row: `n.bodyId` lands in `neuronId` because it is first in
both lists. See `PROPERTY_NAMES` in `schema.ts` for the one place that mapping is stated.

**Don't percent-encode a dataset id in a path.** Every id contains a colon
(`hemibrain:v1.2.1`) and neuPrint's router matches the raw segment; `%3A` gets a 400. Use
`datasetSegment()`. This surfaced as _zero skeletons and no error_, because the concurrency
helper was swallowing every failure — it now rethrows when all items fail.

**Guard rails were considered and declined.** `Find Neurons` still defaults to `limit: 0`
(everything), and raw Cypher is sent as typed. That is a deliberate call: these queries hit
a shared production Neo4j, so an unbounded `MATCH (n:Neuron)` on male-cns is a real hazard.
Leave the decision where it is rather than re-litigating it.

**The token** lives in `localStorage` via `credentials.ts`, never in a saved graph. A 401
goes out on a separate channel (`reportAuthFailure`) rather than as an error message,
because errors cross the scheduler as strings and matching on message text rots silently;
`SourcesPanel` subscribes and opens itself.

**Tests use recorded fixtures** in `__fixtures__/`, all real trimmed responses. The
transport is not covered — it cannot be without a network — but it fails loudly.

## CAVE

`src/data/cave/`, and the second backend. FlyWire and everything else served by CAVE — the
info service that lists datastacks, a materialization engine that answers queries against a
frozen snapshot, and per-datastack annotation tables. Nothing above `src/data` knows it exists;
a CAVE dataset node is `dataset.flywire`, built from `DATASET_FAMILIES` exactly as the neuPrint
ones are.

**Everything below was probed live against `global.daf-apis.com` and `prod.flywire-daf.com`
rather than recalled**, and `live.test.ts` is that pass institutionalised — skipped without
`CAVE_TOKEN`, the standing `scripts/check-export.py` has when navis is absent.

### neuPrint is queried; CAVE is downloaded

The single decision the whole module follows from. neuPrint runs Cypher against a shared
production Neo4j, so `findNeurons` compiles a pattern into a query and every question is a round
trip. CAVE's query API has **no regex worth using, no `GROUP BY`, and a 500,000-row cap** — but
its annotations are a few tens of megabytes and are *already* what the Explore widget wants. So
`CaveSource` fetches the neuron index once per dataset through the machinery Explore already
has, pivots it, and answers `findNeurons` from memory: 139,255 neurons in **6.7 s**, then every
query after that is local. The cost is that the first one waits.

That is why `data/neuronFilter.ts` exists. Filtering locally means *Coda* decides what a pattern
means, and it has to decide the same thing the mock does and the same thing Neo4j's `=~` does —
`^(?:…)$`, so `LC.*` matches `LC4` and not `LPLC1` — or one graph pointed at two backends
quietly returns two answers. `compileRegex` and `compileLabelMatch` moved out of `MockSource`
when CAVE became their second consumer; a copy is how the two drift.

### The 64-bit problem, at the other end of the seam

Invariant 8 was written for this. A FlyWire root id is eighteen digits, and **`JSON.parse`
rounds it**:

```text
raw text   "pt_root_id":720575940628857210
JSON.parse  720575940628857200   ✗ a different neuron, silently
json.ts    "720575940628857210"  ✓ matches the bytes on the wire
```

No reviver helps — a reviver is handed the value *after* parsing, so the digits are already
gone. The exact value exists only in the response text, so `json.ts` quotes every integer
literal too wide for a double before the parser sees it. Four things about it:

- **The scan matches a complete string literal first**, so it never looks inside one. The
  obvious `raw.replace(/:(\d{16,})/g, ':"$1"')` is wrong on real data: `neuron_information_v2`
  is free-text user annotation, so a tag reading `root:720575940628857210` gets quotes spliced
  into the middle of a string and the document stops parsing.
- **The decision is per match, by `Number.isSafeInteger`.** A 16-digit value that is genuinely
  exact stays a number; only what a double cannot hold becomes text.
- **The delimiter is part of the match** rather than a lookbehind, which is also what stops the
  fractional digits of `0.1234567890123456789` starting a match.
- **721 ms on the real 64 MB index response**, against 108 ms for a naive parse. Paid once per
  dataset behind the IndexedDB cache and against ~6 s of network — but worth knowing before
  anyone puts it on a hot path.

**The other leg is free, and that was checked rather than assumed: CAVE accepts a *quoted*
eighteen-digit id in `filter_in_dict`** and answers identically to an unquoted one. So ids go
out as text and come back as text, and no number is ever formed on either side. Had it not, the
request body would have needed the mirror image of the same rewrite.

### The 500,000-row cap, and why counting is the only tell

The materialization engine truncates a result at 500,000 rows and says so in a `warning`
header — which its `Access-Control-Expose-Headers` does **not** list, so a browser cannot read
it. Truncation is therefore detected by counting, and refused rather than returned: a short
index is not a visible failure, it is a dataset that silently lacks neurons.

**`hierarchical_neuron_annotations` is over the cap**, which is why the index reads it **one
`classification_system` at a time** — five queries of 17k to 139k rows instead of one that comes
back quietly short. The kinds come from discovery, which has already run, so the split costs no
extra round trip.

That was found by `live.test.ts` on its first run, and it is exactly the class of bug the fixture
suite cannot see. Note the tell that pointed the wrong way: the `table/{t}/count` endpoint reports
**377,699** for that table and **127,978** for `proofread_neurons`, while the tables themselves
yield over 500,000 rows and 139,255 distinct root ids. Whatever it counts, it is not the rows a
query returns — which is also why `DatasetInfo.neuronCount` is filled in from the index after the
fact rather than asked for at listing time.

### A datastack does not describe itself

neuPrint's graph has a `:Neuron` label with properties on it. A CAVE datastack is a bag of
annotation tables with no privileged one — `flywire_fafb_public` publishes six, of which
`proofread_neurons` is the neuron set, `hierarchical_neuron_annotations` is the cell typing, and
`valid_connection_v2` is a **view** rather than a table. Nothing in the metadata says so; the
schema types (`representative_point`, `cell_type_reference`) describe the shape of a row, not
the role of the table.

So `spec.ts` holds one entry per datastack, static for the reason `datasetFamilies.ts` is
static, and it is a deliberately faithful port of the idea `connecto` arrived at in Python for
the same problem. **A datastack with no entry is not offered** — the info service lists thirteen
and most would fail on the first Run, and a dataset that appears in the picker and then fails is
worse than one that is absent.

**Connectivity prefers that view and falls back to counting synapses**, which is `connecto`'s
shape and arrived at for its reason. `valid_connection_v2` is the server having done the
aggregation once: one row per ordered (pre, post) pair with `n_syn`, filterable by root id *and*
by `n_syn`, so a minimum weight is applied before anything is sent — on one neuron's outputs,
4,818 rows / 410 kB unfiltered against 183 / 16 kB at `n_syn >= 5`.

Where there is no such view — **which is most datastacks; FlyWire's is the exception** — the
edge list is built by asking the synapse table for its two id columns and counting locally. The
query API has no `GROUP BY`, so neither the grouping nor the weight cut can be pushed down: every
synapse of every queried neuron is transferred, and `minWeight` is applied *after* counting.
That is still worth having by a long way, because the alternative is not a cheaper query but no
connectivity at all. Measured against Aedes, exactly that case: one neuron's 719 synapses arrive
in 1.1 s and 111 kB and collapse to 508 partners.

Two things about the synapse path were established live rather than assumed. **`select_columns`
sends more than it is asked for** — naming a `*_pt_root_id` returns the whole bound point, so the
supervoxel id rides along and the transfer is about twice what two columns suggest. And
**`refuseIfCapped` is the real bound**: a hub neuron or a large seed set can reach the 500,000-row
truncation, where the view path is one row per pair and cannot.

**Which synapse table is three answers in order, and the order matters.** A configured
`spec.synapses` wins, because it can name a curated table and the column that scores it —
FlyWire's `synapses_nt_v1` with `cleft_score`, on a datastack that declares
`synapse_table: null`. Otherwise the datastack's **own declaration**, which is what makes a
hand-named datastack work with no configuration at all: 7 of the 13 the info service lists set
it, `wclee_aedes_brain` among them. Its columns are `STANDARD_SYNAPSE_COLUMNS`, which is a
definition rather than a guess — a table whose registered schema is `synapse` has
`pre_pt_root_id`, `post_pt_root_id` and `ctr_pt_position` by `emannotationschemas`, checked
against both a declared and a configured table. `fetchSynapses` resolves the same way, so a
datastack that can answer connectivity by aggregation can also draw the synapses it aggregated;
`positionColumn` is a *stem* the API splits into `_x`/`_y`/`_z`, verified to behave identically
on both.

### Endpoint shapes that are not what a reasonable person would guess

Read off live responses and cross-checked against `caveclient` 8.0.1's own endpoint table:

- **`arrow_format=false` returns `application/json`**, which is what keeps Arrow, a WASM decoder
  and anything new in the main chunk out of this entirely. The cost is `json.ts`.
- **`tables` sits on a v2 path inside the v3 API.** caveclient's v3 map points it at `mat_v2_api`
  while everything around it moved; the v3 spelling 404s.
- **`select_columns` and `select_column_map` are not interchangeable, and each endpoint takes
  exactly one.** A single-table or view query rejects the map —
  `{"schema_errors":{"select_columns":["Not a valid list."]}}` — and a *join* accepts the list
  while warning that it "will attempt to select the first column it finds of this name in any
  table, but if there are more than one such column it will not select both", which is a
  silently wrong column rather than an error.
- **One `/metadata` call lists every materialization with its timestamps**, where `versions`
  returns bare integers and a per-version call turns a listing into a request per entry.
- **`unique_string_values` is the cheap half of discovery**: 52 kB and about a second, against
  tens of megabytes for the annotations. That is what lets discovery run from inference
  (invariant 2) while the index waits until something actually asks for neurons.

### What it costs, and what it declines

**+16.4 kB raw / +5.2 kB gzipped on the main chunk** (1,010.02 → 1,026.39 kB), measured against
a build of the same tree with the feature stashed out. Far under this codebase's bar for a lazy
boundary.

`SourceCapabilities` does the rest, and every `false` is a node that declines at edit time rather
than failing at run time: no skeletons, meshes or synapses (the next phase — FlyWire publishes
precomputed skeletons per materialization and Draco meshes in a CORS-open bucket, so this is
"not wired up" rather than "not available"), no `paths` (it needs a hop aggregated server-side,
which CAVE has no endpoint for), no `rawQuery`, no `viewerScene`, and none of the three ROI
flags — FlyWire's neuropil assignments are a reference table on *synapses*, so there is no
per-region completeness table to read, and a per-neuron breakdown would mean reading a neuron's
synapses and grouping them, which is the work the connection roll-up exists to avoid.
`neuronIndex`, `meshes`, `synapses` and `viewerScene` are true for the source; `skeletons` is
answered **per dataset** through `capabilitiesFor` — see **Skeletons** below.

**The scene is built rather than fetched, and that is the whole of `viewerScene` here.** neuPrint
publishes a curated state per dataset — EM, ROI shells, synapse layers, a framing — which
`buildScene` edits. CAVE publishes no such document, which is why this reported "publishes no
neuroglancer scene"; but its info record names every *part* of one, so `cave/scene.ts` assembles
two layers from it and stops. Anything beyond those two is curation, and inventing it would be
claiming the datastack said something it did not. `layout` and `showSlices` are left off, because
`buildScene` supplies them when absent and a second rule here is a second place for the two to
disagree.

Three things in it, and two of them disagree with `caveclient` on purpose:

- **`graphene://middleauth+…` is what makes the segmentation load at all.** CAVE's segmentation
  is behind its auth and only a spelunker-flavoured viewer authenticates through that prefix.
  Transcribed from `format_verbose_graphene` and checked against it, but as an *insertion* rather
  than the reparse the Python does: `urlparse` reads `graphene://https://host/p` as
  `netloc='https:'`, and rebuilding from the parts only happens to come out right.
- **The image source is passed through, where `caveclient` answers `None`.**
  `format_cave_explorer` routes a `precomputed://` scheme to `format_precomputed_neuroglancer`,
  which handles `gs://`, `http://` and `https://` and falls through to `None` for a URL that
  already carries its scheme — established by *running* it, not by reading it. Every datastack
  probed publishes exactly that form, so porting the formatter faithfully would ship no image
  layer at all.
- **`viewer_resolution_*` is nanometres and neuroglancer's dimensions are metres, divided rather
  than multiplied.** `45 * 1e-9` is `4.5000000000000006e-8` in float64 and that artefact would be
  serialised into the URL verbatim; `45 / 1e9` is exact. 16, 4, 40 and 8 are unaffected either
  way, which is why it survived the first reading — 45 and 50 are not.

**The `#!+` merge works in spelunker too**, which was the open question the moment a CAVE dataset
started opening there rather than in mainline neuroglancer — the merge form was established
against the deployed Google viewer. Confirmed by reading spelunker's own bundle: its
`updateFromUrlHash` branches on `#!+` *before* the `#!` case and calls `restoreState` with no
`reset()`, which is exactly the semantic the camera-preserving update depends on.

**`DatasetInfo.viewerSite` came with it**, and it is a fact about the dataset rather than a
preference: `out.neuroglancer`'s `Viewer` param now defaults to *empty*, meaning the dataset's own
deployment and only then the built-in. A CAVE scene opened in mainline neuroglancer draws the EM
volume with no neurons in it and nothing saying why, because mainline does not speak
`middleauth+`. Absent on every neuPrint dataset, whose states open anywhere.

**`roiCounts` is new, and `fetchRoiCounts` became optional to make room for it.** It was the one
per-backend method on the seam that was required and ungated, and the cost of that showed up two
levels away rather than at the node: `out.profile` fetches its regions in a `Promise.all` beside
two connectivity queries, so a source that rejected there took all three down and **every tile on
the card reported an error** — on a neuron whose partners had loaded perfectly well. The regions
leg is now independently absent, which is the widget's own "a tile renders only when its data
exists" rule, and `neuron.roiCounts` gained the `sourceSupports` gate its two ROI siblings
already had.

Two absences show up as data rather than as flags. A CAVE dataset reports **no ROIs and no
statuses**, so Find Neurons' region and status pickers offer nothing to filter by — which is the
honest state rather than a control that would match nothing.

### Morphology: meshes and synapses, but not skeletons

### Skeletons come from the level-2 cache, and the capability is per dataset

**A CAVE datastack's skeletons depend on its chunkedgraph, not on the backend**, so
`capabilities.skeletons` — which is per *source* — was telling every FlyWire-production user
something false. `DataSource.capabilitiesFor(datasetId)` is the seam that fixes it: synchronous,
`undefined` meaning "same as the source", read by `sourceSupports` ahead of the source's own
answer. Only CAVE implements it, and only for `skeletons`; the Skeletons node's refusal now says
"This **dataset** has no skeletons".

**The route is the level-2 chunk graph, which is `fafbseg.flywire.get_l2_skeleton()`'s method.**
Two requests per neuron: the graph of which level-2 chunks touch which, then the L2 cache's
`rep_coord_nm` and `max_dt_nm` per chunk. Measured on BANC: five neurons concurrently in 3.2 s —
which is one neuron's latency, since they overlap — and trees of 739, 69 and 2 nodes with radii.

**The skeleton *service* several datastacks also publish is not used, and that is measured
rather than assumed.** It generates from this same cache, so it covers no datastack the L2 route
does not: `flywire_fafb_public` declares a service and has no cache, which is exactly why its
skeleton cache was found empty in the phase before this. On one BANC neuron the service took
10–45 s to generate against 1.6 s here, and returned 74 vertices against 146 chunks. It is also
blind to `wclee_aedes_brain`, which has a populated cache and publishes no service at all.
`caveclient.l2cache.has_cache()`'s rule is the gate — the table mapping lists the chunkedgraph
tables the cache knows, and membership is the answer — verified against the live refusal
("Dataset flywire_public does not have an L2 Cache") rather than trusted.

Six of the thirteen datastacks have a cache: BANC, FANC production, FlyWire *production*,
minnie65 public, Aedes and zheng_ca3. **`flywire_fafb_public` does not**, so the node Coda ships
still declines — correctly, and now for the right reason.

Four things in the tree building, each a wrong picture if lost. **Chunks with no cache entry are
dropped, and dropped _before_ the walk** — after it they would orphan their children, where
excluding them lets the walk route around through whatever else they touched (`navis.remove_nodes`
reparents for the same reason; doing it up front needs no reparenting). **A breadth-first
spanning forest**, because the L2 graph is undirected and can hold cycles while a skeleton is a
tree — a cycle surviving into `parents` makes every consumer that walks to a root loop forever.
**Each component gets its own root**, so a neuron split by an edit is two trees rather than one
with a fabricated join. And **a single-chunk neuron answers `undefined` before the cache is
asked**, which is `readGrapheneMesh`'s answer to the same shape of question and saves a round
trip on a common case.

**The attributes call is batched across the whole request, and that is the shape of the fetch.**
It is keyed by *table*, not by root id, so the union of every neuron's chunks goes in a handful
of requests however many neurons were asked for — a hundred neurons is a hundred chunk-graph
reads plus about three attribute reads, rather than two hundred round trips. Measured: 1,177
chunks (twelve neurons' worth) answered in **one 1.64 s request**, against roughly that for each
of the twelve separately. The cost is that progress reports in two phases rather than per neuron.

**`L2_CONCURRENCY` is 16, and it is set by correctness rather than by the curve.** Measured
against BANC, 40 neurons: 14.5 s at 8, 4.6–6.0 s at 16, 3.9–4.9 s at 32, 5.2 s at 48 — three
times faster at 16 and flat after. But **past 16 the server starts dropping requests silently**:
two of three runs at 32 returned 38 and 39 skeletons of 40, and one at 48 returned 39, where
every run at 8 and 16 returned all 40. `mapWithConcurrency` turns a failed neuron into an
`undefined` indistinguishable from a neuron that genuinely has no skeleton, so the missing ones
do not announce themselves.

`MAX_L2_SKELETON_NEURONS` is 100 — far above `MAX_MESH_NEURONS`' 20, because a skeleton is one
chunk-graph read where a graphene mesh is several hundred requests, and far below the 500 a
source publishing ready-made skeletons allows.

**Points come out in visit order, so a parent always precedes its child.** That is the contract
`SkeletonGeometry.parents` states and that `neuprint/decode.ts` does real work to honour;
emitting in chunk-id order would satisfy the type and break every consumer that walks the array
once, the SWC writer included. The test for it uses edges whose *encounter* order differs from
their *visit* order, because on a chain listed front to back the two coincide and a test built on
one passes whichever the code emits.

**`capabilityOf(source, datasetId, key)` is how a capability is read**, never
`source.capabilities[key]` directly. The per-dataset override is useless to a reader that skips
it, and the two halves of a gate usually sit in different layers — `validate` refuses at edit
time and `evaluate` at run time — so a bypassing reader makes them disagree with nothing
type-checking the pair. Six readers did exactly that when the override was introduced; they all
go through the resolver now. `starters.ts` passes no dataset id and gets the source-level answer,
which is honest there: a starter is a node type and some params, and which dataset it resolves to
is not known until the node runs.

**The skeleton is coarse and the docstring says so.** One node per level-2 chunk is tens to a few
hundred for a whole neuron, where a traced skeleton is thousands. It is the right shape for
NBLAST, a 3D overview and cable length; it is not a morphometric reconstruction.

#### The earlier finding, kept because it explains the shape

**The skeleton service is the one thing CAVE publishes that Coda still cannot use, and the
blocker is the service rather than the format.** `skeleton_source` is a standard `neuroglancer_skeletons`
precomputed endpoint — its `/info` declares `radius` and `compartment`, which is exactly what
`SkeletonGeometry` wants, and it is CORS-open. But it is a **cache that generates on demand**,
and for `flywire_fafb_public` it is empty: 100 proofread root ids sampled from two places in the
table, across skeleton versions 0 through 4, came back `exists: false` for every one, and a
queued bulk generation had not landed after five minutes. So a fetch blocks on generation, per
neuron, against a node whose ceiling is 500. `capabilities.skeletons` is false and says so on
the flag; claiming it would make every Skeletons run hang instead of decline.

Two endpoint notes for whoever picks this up when the cache fills. `exists` answers as a **POST**
(`{skeleton_version, root_ids}`) — the GET form 502s — and it is what makes the whole thing
usable, because it turns "will this hang?" into a question you can ask first. And omitting the
skeleton version from a fetch URL routes to a generate rather than 404ing, which is why the first
probe here simply never returned.

**Synapses are the cheapest capability on this source and needed no new transport.** It is
`queryTable` with a root-id filter — the same call connectivity makes — over `synapses_nt_v1`.
Measured: 14,986 synapses for one neuron in 1.8 s.

- **`desired_resolution: [1, 1, 1]` is where the nanometres come from**, and it is passed
  explicitly rather than inherited. The table stores **4x4x40 nm voxels**, established by asking
  for both resolutions and watching the values divide by exactly 4, 4 and 40. The server's
  current default for this table happens to *be* nanometres, so omitting it looks perfectly fine
  and would put every synapse a factor out of the scene the day that default moved — with
  nothing failing, because the cloud is internally consistent either way. This is the CAVE-native
  answer to the rule `neuprint/units.ts` implements by scaling.
- **No polarity means two queries, not one.** CAVE has no either-end filter, and an `IN` on both
  columns of one query is an AND — which is the synapses a neuron makes onto *itself*.
- **The cloud is query-relative**, like `fetchConnectivity`: `neuronId` is the end that matched
  the filter and `partnerId` the other, so a Synapses node and a Connectivity node on one neuron
  agree about which id is whose. `polarity` rides in the attribute table because a cloud fetched
  for both ends is two populations in one buffer.

**Meshes work, and cost requests rather than bytes.** A CAVE segmentation is `graphene://`, which
is not a bucket you can read by id: a root id is a dynamic agglomeration, so the fragment list has
to be asked for. `meshes.ts` asks the meshing API, then hands the fragments to
`src/data/precomputed` unchanged — `decodeDracoFragment` and `concatMeshes` needed no edit at all.

**A manifest failure is deliberately *not* swallowed**, which is the opposite of `readLegacyMesh`
beside it. That one reads a static bucket where a 404 genuinely means "this body has no mesh";
this calls an API whose 404 means the *table name* is wrong — the trap named just below. Letting
it throw is what lets `mapWithConcurrency` do its job: one bad neuron still becomes `undefined`
and costs the others nothing, but a systematically broken call fails every neuron and is
rethrown, rather than handing back an empty scene under a green node.

**The bucket mapping is `objectStoreUrl` in `precomputed/transport.ts`**, shared with
`neuprint/nglayers.ts`, which is where the second consumer put it. The first copy here mapped an
*unrecognised* scheme onto the GCS host — a confidently wrong URL rather than a refusal, and 404s
per fragment that read as neurons with no mesh. Not every CAVE datastack is on GCS.

Four things established live, each of which would otherwise be a plausible wrong picture:

- **`verify=True` is not optional.** Without it the manifest answers a single fragment named
  after the root id itself, which does not exist in the bucket — the unverified form is a promise
  about what *would* be meshed rather than a list of files. With it, one FlyWire neuron is **492
  fragments**.
- **The meshing API is keyed by the graphene *table*, not by the datastack**, and on FlyWire
  those are different strings: `flywire_public` against `flywire_fafb_public`. Taking the
  datastack name 404s, so the table is parsed out of the `segmentation_source` URL that named it.
- **Fragments decode straight to world nanometres.** Measured on a real one: x spans
  474,201–474,810. So none of `multires.ts`'s `fragmentOffset`/`fragmentTransform` machinery
  applies, and nothing scales anything — the decoder is called with an identity transform.
- **The bucket is CORS-open** (`storage.googleapis.com`, `access-control-allow-origin: *`), so
  this works from a static deploy with no proxy.

**What it costs, all measured on one neuron:** 492 requests, ~1.2 MB, **13.3 s**, and 1,276,736
triangles before decimation. There is no level of detail to trade against — a graphene manifest
lists supervoxel fragments at full resolution, where neuPrint's multi-resolution meshes answer in
a handful at a chosen LOD. Three constants follow from that, and each is a measurement rather
than a guess:

- **`MAX_MESH_NEURONS` is 20**, against the Skeletons node's shared 500. Enforced in the *source*
  rather than on the node, because it is a fact about graphene: the same Meshes node against
  neuPrint is fine at 500. (A per-source ceiling on the seam is the honest fix and is a later
  phase; the refusal names the number and the reason meanwhile.)
- **`FRAGMENT_CONCURRENCY` is 32.** The work is latency, not bytes — 492 fragments averaging
  2.4 kB — so this is the number that decides the wait: 18.9 s at 12, 13.3 s at 32, 11.3 s at 64.
  Past 32 the gain is small and it is a lot of parallel requests at one host. Measured from Node,
  where nothing caps connections, so a browser will do no better.
- **`MESH_DECIMATE_GRID` is 192**, through the same `decimateMesh` the ROI shells use. Much finer
  than their 32, because a neuron is a thin arbor inside a box the size of the brain and that
  grid would erase it: from 1,276,736 triangles, grid 96 gives 6,308, 192 gives 25,548, 256 gives
  44,091. A full set of 20 is then about half a million triangles, inside the 1.5M budget the
  Meshes node works to. It reduces memory and draw cost, not the wait — the requests are already
  paid by then.

**`fetchCoarseGeometry` stays unimplemented, and that is the right answer rather than a gap.**
There is no cheap representation to draw a thumbnail from, and the interface's own docstring says
an absent one beats quietly downloading full detail to fill a list. So Explore on a CAVE dataset
draws placeholders.

**The cross-check that ties it together** is in `live.test.ts`: a neuron's mesh has to enclose its
own presynaptic cloud. Neither is scaled by anything here — the fragments arrive in world
nanometres and the synapse query asks for them — so if either assumption were wrong the two boxes
would be a whole factor apart, and nothing else would fail, because each is internally consistent.
Measured: mesh 400,953–603,981 against synapses 402,596–602,328. Same shape as the neuPrint rule
that a mesh bbox must enclose its skeleton's.

**The morphology schema is narrowed rather than canonical.** `neuronId`, `type` and `points`, and
no `instance`, `status`, `size` or `cableLength` — a graphene mesh carries none of them, and a
column that arrives null on every row breaks every picker that believed it.

### Smaller decisions

- **`neuronId` is `str` on this source, and `type` is the only other renamed column.**
  `pt_root_id` → `neuronId` and the `cell_type` annotation kind → `type`; everything else keeps
  CAVE's own spelling (`super_class`, `cell_class`), the same call neuPrint's passthroughs make.
  What `str` costs is numeric sorting of ids and their appearance in numeric pickers, neither of
  which is a loss.
- **A failed discovery is asked for once, not once per keystroke.** `schemasFor` runs from
  edit-time inference and `runDiscovery` sets its schema only on success — so without a
  `discoveryRequested` flag every failure was retried on every graph mutation: one 52 kB request
  per keystroke, or one auth-failure popup per keystroke with no token. Exactly the rule
  `peekDatasets` already states for the listing beside it, and the reason neither flag is cleared
  on failure. Pressing Run still retries, because the index path calls `discover` regardless.
- **The index's two legs run together.** The annotation queries depend on nothing from the neuron
  table — only on the server and the discovered kinds — so awaiting it first cost a round trip
  plus 139,255 rows of transfer. Measured against live CAVE: 5.76 s to 4.04 s.
- **`typesOf` is memoised on the index's identity.** `fetchConnectivity` is called once per hop
  per direction, so `Hops: 3, Direction: both` built the same ~108,000-entry map six times in one
  Run, and Profile built two per page turn. A `WeakMap` on the `TableValue` is safe rather than
  merely likely to hit: `cacheGet` promotes a hit into `cache.ts`'s module map and hands back the
  same object. Same idiom as `searchIndexFor` and `statsFor`.
- **A dataset id is `datastack:materialization`** — `flywire_fafb_public:783` — following
  neuPrint's `family:version` convention exactly, which is what lets the existing version
  dropdown carry a materialization with **no new control**: `compareVersions` orders bare
  integers, so 783 sorts above 630 and a pinned 630 stays 630.
- **The index is deduplicated on the root id.** A CAVE neuron table is keyed by a *point* — a
  soma, a nucleus, a representative vertex — so one segment carrying two of them is two rows for
  one neuron, and a repeated row is double-counted by everything downstream that sums a weight.
- **Connectivity types come from the index**, not from a second query. A connectivity table
  without them is readable by nothing, and by the time anyone runs Connectivity the index is
  already in hand. A partner outside the annotated set has no type, which is honest rather than
  a gap.
- **There is no Base URL field**, unlike neuPrint's, and its absence is the finding: every CAVE
  service Coda calls answers a browser directly, **including on its 401s**, which is the part
  `reportAuthFailure` depends on. What the Connections tab does carry is a *global server*,
  which is a different thing — CAVE splits into one service that knows which datastacks exist
  and a per-datastack `local_server` that answers queries, and only the first is ever named.
- **A CAVE 401 opens the CAVE tab.** `reportAuthFailure` carries no source id, so the Connections
  panel used to declare one `authTab` per section, hardcoded to neuPrint. Harmless while neuPrint
  was the only credentialed backend and wrong the moment CAVE arrived; the *tab* is now named by
  whoever subscribes. The `section.authTab ? …` branch that chose whether to wrap a body was
  reading an auth detail to answer a layout question and is now an explicit `tabbed` flag.
- **Both exporters skip it, and the export is refused outright.** `dataset.flywire` is named in
  each `NO_EMITTER` with its reason — the notebooks are built on neuprint-python and neuprintr,
  and emitting neuPrint code against a dataset neuPrint has never heard of would produce a
  document that runs and answers nothing. The loops and `canExportNotebook` both read
  `DatasetFamily.notebook`; see the exporter section above for why that is one field rather than
  a test repeated at each site.

### What is not done

Skeletons, until the skeleton cache has anything in it (above). The annotation-source
abstraction that would let a FlyTable or a GitHub TSV join onto root ids, and the
materialization/annotation dropdowns and per-source morphology ceilings. Aedes needs the
annotation half before it is usable at all: its CAVE datastack publishes synapses and nuclei and
*no* annotations, so type, class and side live in FlyTable.

Not looked at in a browser yet — the module is headless and both suites are headless, so what has
not been seen is a FlyWire dataset node on a real canvas: the Explore widget over 139,255 neurons,
and twenty decimated meshes with their synapses in the 3D view. Same standing as the WebGL
viewers, and the mesh path is the half most worth looking at, since a decimation grid is a
judgement about a picture.

## Precomputed meshes

`src/data/precomputed/` reads neuroglancer precomputed meshes. It knows nothing about
neuPrint — FlyWire and CAVE are the obvious next consumers — and `src/data/neuprint/nglayers.ts`
is the only thing that maps a dataset to a bucket.

**Meshes need no token and usually no proxy.** They come from public object stores, not from
neuPrintHTTP. `neuroglancer-janelia-flyem-hemibrain`, `manc-seg-v1p2` and `flyem-optic-lobe`
all send `Access-Control-Allow-Origin: *`, so they are fetched directly and work in a static
deploy even where the Cypher API cannot reach. `flyem-male-cns` sends no CORS headers at all,
so `transport.ts` retries it through the `/gcs` proxy and remembers, per host, which route
worked. A browser reports a CORS refusal as an opaque `TypeError`, so trying is the only way
to find out — which is why the answer is cached rather than probed each time.

**Find the source through `/api/npexplorer/nglayers/<dataset>.json`, not `Meta`.** The Meta
node is unreliable (hemibrain has `neuroglancerMeta`, manc:v1.2.3 has nothing); the nglayers
endpoint always names the segmentation. Ignore the `*_property` sidecars, of which male-CNS
has eight.

**Preference order is multi-res layer → segmentation volume → any other mesh-shaped layer,**
and the two ends pull against each other:

- optic-lobe's volume declares `mesh: single-res-meshes` (flat, full resolution) while a
  `multi-res-meshes` **sibling** exists and is what its state links. So a dedicated multi-res
  layer must beat the volume.
- male-CNS's state advertises `meshes-malecns/single-res-meshes` while its volume declares
  `mesh: multi-res-meshes`. So a _legacy_ dedicated layer must **not** beat the volume.

Preferring any hinted layer over the volume — which this originally did — got male-CNS wrong
with nothing failing: meshes still arrived, just at full resolution and several megabytes each.

**Two formats, detected from the mesh dir's `info`.** All four datasets in use publish sharded
`neuroglancer_multilod_draco` with four levels; the legacy `neuroglancer_legacy_mesh` path
exists because optic-lobe and male-CNS also publish single-resolution directories, and a
misresolution lands on one.

Four things about the sharded format that are easy to get wrong, all of them found the hard
way and all pinned by tests:

1. **Shard math.** `shifted = key >> preshift_bits`, then murmurhash3_x86_128 of its 8
   little-endian bytes, taking `(h2 << 32) | h1`; minishard is the low `minishard_bits`, shard
   the next `shard_bits`. Body 1158187240 must land in shard `0x151`, minishard 103.
2. **Fragment positions are three arrays, not interleaved triples** — every x, then every y,
   then every z. The wrong reading still yields valid coordinates and is _invisible at the
   coarsest level_, where hemibrain's `0,0,0,0,0,1,0,1,1` decodes identically either way. It
   showed up one level down as fragments scattered across the volume.
3. **`vertexOffsets` are not zero** (hemibrain: 1 at LOD 1, 4 at LOD 3). Dropping them shifts
   geometry by 16–64 nm, which reads as rounding.
4. **Fragment data sits immediately _before_ the manifest** in the shard. There is no pointer
   to it; `dataStart = manifestOffset - Σ every fragment size`.

**Everything is nanometres.** neuPrint returns skeletons and synapses in dataset voxels
(8 nm), precomputed meshes come out in nm — drawn together unconverted, the mesh sits 8× away
from the skeleton it should wrap. `neuprint/units.ts` scales the neuPrint side using
`Meta.voxelSize`, so `cableLength` is in nm and skeleton coordinates no longer match the raw
API response. That is the trade, and it is checked: a mesh bbox must enclose its skeleton's.

**`Max neurons` bounds requests; `Detail` bounds weight; `maxBytesPerBody` bounds one neuron.**
Three different guard rails. Conflating the first two is how the mesh limit ended up at 25 — a
number from before levels of detail existed, which refused thirty neurons that would have
arrived as a few hundred kilobytes. All three morphology nodes now share the `MAX_NEURONS`
ceiling.

The third exists for thumbnails, and it is needed because **even the coarsest level has a
2000× spread**. Sampled across hemibrain, the coarsest level is 264 bytes at the median, 14 kB
at p90 and 508 kB at the maximum (male-CNS: 7.3 kB / 23 kB / 169 kB). A budget averaged over a
batch cannot express "skip this one body"; the manifest carries the size, so the decision costs
no download.

**`THUMBNAIL_MAX_BYTES` is a guard rail, not a quality filter,** and the distinction is the
whole point of the number. It is 2 MB, above the largest coarsest level in any dataset here, so
every real neuron gets a thumbnail; 2 MB is what an entire hemibrain neuron costs at full
resolution (2 MB / 280 kB / 48 kB / 11 kB), so a body whose _coarsest_ level reaches it is an
unsplit blob rather than a large neuron. It was 128 kB, pitched just above p90 to keep a page
cheap — which blanked the giant fibres and big tracts, i.e. both the heaviest coarse meshes and
the bodies someone browsing is most likely to want. A page is priced by the median, not by the
ceiling, so raising it costs the typical page nothing.

**Detail is chosen, not fixed.** `chooseLod` picks the finest level fitting a triangle budget
across the whole batch, using the manifest's compressed byte sizes as the pre-decode proxy at
~1.7 bytes/triangle. That ratio is dataset-dependent (optic-lobe overshot 2×), so the result
reports the triangles actually decoded and the viewer caption shows `mesh LOD n/m`.

**The Draco decoder must stay out of the main chunk.** `draco3d/draco_decoder_nodejs.js` is
misleadingly named — it is a universal Emscripten build whose `require("fs")` is behind a
Node-only guard — and the wasm is handed over explicitly via a `?url` import so Emscripten
never guesses at a path the bundler has hashed. Do not import three's `DRACOLoader` here:
it would pull three.js into `src/data`, which has to stay usable by a non-browser consumer.

## Dataset nodes

**One node per dataset, not one generic picker.** `Add ▶ Dataset ▶ MaleCNS` replaces choosing a
backend and then a dataset within it; the node arrives already pointed somewhere and asks only
for a version. The old `neuron.dataset` is still registered and `hidden`.

**The family list is static; everything that changes is live.** Node types must exist at module
load — the store resolves them the moment it deserialises the autosaved graph, so a type
registered after a listing resolved would make a saved graph visibly lose its nodes. A dataset
listing is a network call. Those cannot both be satisfied by generating nodes from the listing,
so `nodes/lib/datasetFamilies.ts` holds one static entry per family carrying _only_ presentation
(label, blurb, glyph), and versions, ROIs, schemas and counts are all read from the source. A
family Janelia adds later needs a line there; `Custom neuPrint` covers it meanwhile. Verified
against the live listing: the visible families are exactly fib19, hemibrain, male-cns, manc,
mushroombody and optic-lobe (banc and wasp3 are `hidden: True` server-side).

**An empty `version` means latest, resolved identically at infer and eval time** so the
provenance key cannot disagree with what ran. The dropdown's first option is labelled
`Latest (v1.2.3)` rather than `Latest` — an unnamed "latest" is a provenance question mark on
every shared graph. A _pinned_ version that the server no longer lists is kept, not silently
upgraded, and `validate` reports it.

`compareVersions` compares numeric segments, so `v1.2.3` > `v1.2.1` > `v1.0` and a future
`v1.10` > `v1.9`. A string sort gets today's data right by luck and that one wrong.

**"Server" means two different things and they are not interchangeable.**

|                             | means                                          | example                        |
| --------------------------- | ---------------------------------------------- | ------------------------------ |
| a dataset node's `Server`   | a neuPrint **deployment**                      | `https://neuprint.janelia.org` |
| Connections → `Base URL`    | an **override** of the URL the browser fetches | `/neuprint`                    |

`data/neuprint/servers.ts` maps a deployment to the routes worth trying. **An empty `Base URL`
is a real answer, not a synonym for the proxy**, and that distinction was a bug: the field used
to fall back to `/neuprint` when cleared, so "remove the proxy" silently meant "use the proxy"
and the field appeared to revert on its own. Empty now means work it out; naming a URL collapses
it to that one route with **no fallback**, because somebody who named a base has said where the
request goes and quietly trying elsewhere would report success for a wrong entry. The override
applies to the **default deployment only** — a Custom node names its own origin, and letting an
override capture it would send one deployment's queries to another's proxy.

A non-default deployment falls back to `/np/<encoded-deployment>/…`, served by the
`deploymentProxy` plugin in `vite.config.ts`. **That plugin refuses anything but https to a
public host** — a dev server that forwards wherever a page points it is an SSRF hole aimed at the
developer's own network. Note what that path costs in a static deploy, which is how this was
found: on GitHub Pages `/np/…` is served by nothing, so a Custom node pointed at a CORS-enabled
deployment used to fail with GitHub's own 404 without ever attempting the direct route that
would have worked.

`NeuPrintSource` takes a deployment in its constructor and every HTTP call goes through its
private `options()`. A call site that forgets the base URL does not fail; it quietly queries the
_default_ deployment and returns plausible data from the wrong server. `neuPrintSourceFor()`
registers one instance per deployment, lazily, from `inferOutputs` — synchronous and network-free,
which is what makes that safe.

**`hidden: true` keeps a superseded type loading without offering it.** Registration is what
makes a saved file load (an unregistered type renders as "Unknown node" and drops its params);
listing is a separate question. `listableNodeDefs()` is what the add surfaces read, `allNodeDefs()`
stays complete.

**Node bodies opt into expanding.** `NodeBodyEntry.expandable` is off by default: a dataset body
is a preview and two fields, so a fullscreen overlay of it is whitespace, and its button would sit
exactly where a viewer's does. Explore and the Description card set it; the dataset nodes do not.

The preview at the top of a dataset node is a **placeholder** — a specimen silhouette, not a
rendering of the data — but it occupies the space a real one will take. Six drawings cover every
dataset and a seventh is never required: the glyph is keyed to a coarse anatomical kind declared
in the family table, with `specimen` as the fallback, so a dataset added tomorrow is never blank.
Same rule as `NodeThumbnail`, same reason.

## Attribution: the Description companion

Every published dataset node arrives with a `dataset.description` card wired to it. A connectome
is years of someone's reconstruction work published with a request for attribution, and a picker
labelled "MaleCNS" gives no hint of that — so the credit is **on the canvas by default and has to
be dismissed**, rather than being available somewhere and never looked for.

**The text is neuPrint's, not ours.** `/api/dbmeta/datasets` publishes a markdown blurb per
dataset — a summary, the project landing page, companion viewers, and the papers to cite — which
`DatasetInfo.description` has always carried and nothing rendered. Restating any of it in the
family table would be a second copy that goes stale the day a dataset adds a citation, and would
be simply absent for `Custom neuPrint`, which can point at a deployment this build has never
heard of.

**The card shows the blurb and nothing else.** No dataset id, no version, no neuron counts: it
sits directly under the node that feeds it, so every one of those would repeat something an inch
away, and the card is narrow. The three _absences_ are said apart, though — "publishes no
description" is a fact about the dataset, while "has not listed its datasets yet" is a state the
card is passing through, and one message for both makes a card that is about to fill itself look
like one that never will.

**`companion` is on the `NodeDefinition`, and `addNodeWithCompanion` is the only way in.** See
`core/companion.ts`. Three properties, each of which would be worse than having no card at all if
lost:

- **A suggestion, not a fixture.** Delete it and it stays deleted — nothing repairs the graph on
  a later edit. `Add ▶ Dataset ▶ Description` is how it comes back.
- **On add, never on load.** The store's `addNode` and `buildStarter` call it; deserialisation
  does not. A saved file that grew a node every time it opened would be unusable.
- **One undo step.** Both nodes and the edge go in through a single `commit`, and the selection
  stays on the node that was actually asked for.

**The synthetic families opt out** via `DatasetFamily.synthetic`. There is nobody to cite for a
connectome generated in the browser on load, and a credit card with no credit on it devalues the
ones that mean something. Note the knock-on in tests: a mock starter has one fewer node than a
neuPrint one, which is why `explore.test.tsx` still finds Explore's expand button first.

**No outputs, which is the one deliberate departure from the `out.*` viewers.** Those pass their
input through so they can be dropped mid-chain; this is an annotation hanging off a dataset node,
and an output socket would invite wiring a pipeline through the credits.

**`cheap`, and `evaluate` usually fetches nothing.** The body draws from `peekDataset`, so the
text appears as soon as the listing lands whether or not anything has run — that is what makes it
an annotation rather than a result. `evaluate` only calls `listDatasets` when the peek is empty,
because `listDatasets` re-fetches on every call and this node runs on the same cheap pass as the
dataset node that has just done it.

### Rendering someone else's markdown

`ui/markdown.ts` parses a subset to an AST; `MarkdownView.tsx` turns that into React elements.

**The AST is the security boundary, and it is why there is no markdown dependency.** Every
library in that shape emits an **HTML string**, so safety rests on a sanitiser being configured
correctly and staying that way. Here raw HTML in a blurb is a `text` node that React escapes, and
`safeHref` refuses any scheme outside http/https/mailto — so a hostile description cannot become
markup by construction rather than by configuration. `markdown.test.ts` covers the refusals;
`descriptionBody.test.tsx` covers that the _render_ path agrees.

Two parsing details that real data forced:

- **Link targets are scanned with paren depth, not to the first `)`.** DOIs and wiki URLs carry
  balanced parens, and truncating one yields a link that silently 404s.
- **`safeHref` strips whitespace and control characters before testing the scheme and returns the
  original.** `java\tscript:` is a scheme browsers accept and a naive test does not; stripping
  before rather than after errs towards refusing.

A refused link degrades to its label as plain text. Dropping it would hide that anything had been
written there.

## Auto-wiring the Dataset socket

A node added with a `Dataset` input arrives already wired to the dataset on the canvas, when
there is exactly one to wire it to. `core/autowire.ts`, applied in the store's `addNode` inside
the same `commit` as `addNodeWithCompanion` — so the node, its companion and the wire are one
undo step. Nearly every query node opens with the same question, and on a one-dataset canvas
that wire is a gesture with no decision in it.

**`dataset` sockets only, and that is the whole of it.** A dataset handle is a fact about the
_workspace_ — this graph is about hemibrain — where a table is a step in a pipeline. One table on
a canvas means a canvas half built, so guessing there would wire a new node to whatever happened
to be lying nearest, which is worse than an empty socket precisely because it looks deliberate.

**Counted over dataset _nodes_, never over resolved dataset ids.** Reading two nodes that both
resolve to `hemibrain:v1.2.1` as "one dataset" is tempting and unsafe: a node left on `Latest`
publishes no dataset id until the listing lands (invariant 2), so on a fresh tab two nodes
pointing at _different_ connectomes are indistinguishable — which is exactly the moment the wrong
guess would be made, and the moment nothing on screen could explain it. Two candidates means the
socket is left empty.

**On add, never on load and never as a repair.** Same rule and same reasoning as `companion.ts`:
a saved graph must reproduce itself exactly, and a socket somebody unplugged stays unplugged.
Deleting one of two datasets does not retro-wire what is left.

**`duplicateSelection` is deliberately not routed through it.** Duplicating already declines to
copy edges from outside the selection — a clone must not silently inherit inputs — and a clone
that arrives wired to something its original was not would be that same surprise by another
route.

The one visible interaction is with the palette's link-drag, which adds the node and then
connects it: the auto-wire lands first and `addEdge` evicts it if the drag was aimed at the same
socket, so the two agree by construction. A drag from a _table_ output onto, say, Connectivity
now fills both of its inputs at once.

## Text notes

`note.text`, added from `Add ▶ Utility ▶ Text`: a framed block of markdown on the canvas. It is
what a graph cannot say about itself — why this type pattern, why this threshold, what the chart
at the end is meant to show.

**It is a `GraphNode` with `annotation: true`, and both halves of that are deliberate.** A
separate `annotations` array on `CodaGraph` would have to re-implement position, selection,
undo, autosave, serialisation, the library, duplication and the minimap — every one of which a
node already has — for a feature whose entire content is a string. So it is stored as a node.
What makes it _not_ a node is the flag: no ports, never evaluated, no provenance key anyone
reads, and its own card.

`annotation` is read in exactly five places, and each one would be a visible lie without it:

- `Scheduler.refreshStates` gives it **no state at all**, not even `idle`. With no cache entry it
  can never be fresh, so a labelled note would sit permanently `stale` — counted by the toolbar
  badge, re-offered by every Run, for a paragraph of prose.
- `Scheduler.execute` skips it, so it lands in neither `executed` nor `deferred`.
- The store's `needsRun` returns false (the palette's stale count reads through it), and
  `toggleDisabled`/`toggleCollapsed` filter it out. Collapsing is the dangerous one: a note draws
  no header, so a collapsed one would have nothing left to press.
- The inspector drops its Ports and Result sections; the context menu drops Run, Invalidate, Mute
  and Collapse; the palette disables Run Selected and Expand. Params stay — for a note that is a
  full-width editor for the same string, which is the better place to write more than a sentence.
- `NodeThumbnail` draws a framed box of text lines rather than a card with a header strip, so the
  browser tile does not promise sockets the inserted thing does not have.

**Read mode drags, edit mode types.** The rendered view is draggable everywhere, which is what
makes a note a thing you push around; the cost is that its text cannot be selected with the
pointer, since that gesture moves the card. Double-click swaps in a `nodrag` textarea. Blender
and ComfyUI make the same trade and it is the right way round — notes are moved far more often
than they are re-read a phrase at a time.

**Escape reverts through a ref, and that is not incidental.** Unmounting a focused textarea can
fire blur on the way out, so leaving edit mode is not a way to express "cancel" — the blur
handler would commit the very edit being abandoned. Escape sets `reverting`, blurs, and the blur
handler reads the flag and skips the write.

**The frame is the object, and it is quiet.** The paper is 1.13:1 against the light canvas, so
the _border_ is what says "a different kind of thing". Achromatic, and one value for both
themes: `#7d7b76` is the grey that clears the 3:1 non-text floor on all four surfaces it can
meet — 3.98:1 and 3.52:1 on the light paper and canvas, 4.16:1 and 4.43:1 on the dark pair.
`--text-muted` would have served except on the light canvas, at 2.99:1, which is exactly where a
note dragged onto empty space lives. Otherwise the card takes the node's own shadow and a
slightly tighter radius: a note belongs to the same scene, and what separates it is what it
lacks — header, sockets, state bar, footer.

**`outline` is inspector-only, and off removes the whole frame** rather than only the stroke:
border, paper and shadow together, because a paper card with a shadow and no border is still a
card, which is the thing being turned off. Three details are load-bearing. The border stays as
`transparent` so toggling does not shift the text by 1.5px in each direction; a _selected_ note
keeps its accent ring, since a frameless note that also vanished when you tried to pick it up
would be unselectable except by accident; and the frame comes back while the textarea is open,
because an edit needs a visible target. Absent means on, so a note saved before the param existed
keeps the frame it was drawn with.

**The text goes through `ui/markdown.ts`**, the same subset the Description card renders, rather
than a second parser. That module exists because a blurb from a foreign deployment must not be
able to become markup, and text pasted into a graph that is then shared has exactly the same
property — raw HTML stays text by construction.

**Every example carries notes** (`placeNote` in `examples/index.ts`), an overview above the chain
and two or three step notes under it. They are placed absolutely rather than through `place`,
because the node grid is a row of pipeline steps while a note spans several of them. Their source
runs through `dedent`: the markdown parser only recognises a heading at the start of a line, so a
`###` indented to match the surrounding code is a paragraph beginning with three hashes.

Two existing tests had to learn what an annotation is, and the change is the assertion rather
than an accommodation: `examples.test.ts` now expects `executed` to match the _dataflow_ nodes
and `graph.nodes` to be strictly longer, and `App.smoke.test.tsx` counts Run buttons against the
same subset. Counting a note as work is counting the comments in a program as statements.

## Pivot: a matrix and a wide table

`core.pivot` emits **both** shapes of one pivot. `Matrix` is what the heatmap and `Normalize`
take and is a dead end for every ordinary table op, since a matrix carries no schema; `Table`
is the same pivot wide — the row labels in a column named after the Rows field, then one
numeric column per column label — which is what makes a pivot sortable, filterable, joinable
and exportable as the CSV somebody wanted, with no second node in between.

**The table is reshaped from the matrix, not pivoted a second time.** `matrixToTable` in
`tableOps.ts` takes the finished `MatrixValue`, so the two outputs cannot disagree about the
aggregation, the labels or their order, and the data is walked once. It also means an absent
pair reads as `0` in both, rather than as a null the table half invented.

**The wide schema is observed, not derived, and this is the second legitimate use of
`observesOutputSchema`** after Raw Cypher. Its columns _are_ the distinct values of the
Columns field, so nothing short of reading the data can name them and `inferOutputs` may not
fetch (invariant 2). The lifetime is the same as Cypher's: unknown-shaped until the first run
and again after a reload, which reads downstream as "columns unknown" rather than as a table
with none. Note what that costs — the label column's name comes from a param and _is_ known,
but publishing it alone would be a schema that is half fresh and half stale, which is worse
than uniformly stale.

Consequently pivot is the one op in `tableOps.ts` with no `*Schema` half, and invariant 3 is
satisfied a different way: `pivot.test.ts` asserts the two outputs against each other, and
that removing the observation empties the picker on the node downstream.

**`Matrix` stays the first output**, so every saved graph keeps its socket positions, a link
dragged off the node starts there, and the footer — which summarises the first output — still
says `N × M`.

Two small things fall out of a matrix axis being labels rather than data. The label column is
`str` even when pivoted from `neuronId`, which still joins back against the numeric column it
came from because `joinTables` keys on `String(cell)`. And a column label colliding with the
row field's name is suffixed (`type`, `type_2`) rather than dropped, the same call
`joinedColumns` makes.

## Deduplicate

`core.dedupe`, `Add ▸ Transform ▸ Deduplicate`. `pandas.drop_duplicates`: name the columns to
compare on, and `Keep` decides which row of a repeated set survives — `first`, `last`, or `none`.

**It exists because the providers stopped deciding.** Measured against FlyTable's `main.info`:
58,340 rows, 56,309 distinct root ids, 1,089 neurons with more than one row, and one segment
appearing 104 times with its `side` reading left, center and center among them. That used to be
collapsed silently inside `shapeRows`; now it reaches the canvas, and this is the node that
decides what to do about it in a place somebody can see.

**`none` is a different question, not a third flavour.** `first`/`last` answer "one row per
neuron" and differ only in which row a Sort upstream put where; `none` answers "only the rows
nobody disagrees about", which is the conservative read when a repeat is a *conflict* rather than
a copy. That is `keep=False`, and it is the mode worth knowing about.

**Empty compares whole rows**, which is `drop_duplicates()`'s own default and `Select`'s reading
of an empty picker — so an unconfigured node answers "this file has exact duplicates in it" with
nothing set. A column that is *named* but absent is refused rather than dropped, `groupByTable`'s
rule: comparing on fewer columns than were asked for silently keeps **more** rows, which on a
table whose upstream schema moved reads as a dedupe that did not work.

**Row order is the input's in all three modes.** A row kept because it was *last* stays where it
was rather than moving to the end — pandas does the same, and a dedupe that also reordered would
be two operations wearing one name. Note the trap in the implementation: `lastAt.values()` is in
*first*-occurrence order, so the second pass walks the rows again rather than reading the Map.

**`rowKey` is shared with `groupByTable`** rather than written twice — the second-consumer rule,
and the two characters in it are the whole of its correctness. `\u0001` separates columns, so
`["ab","c"]` and `["a","bc"]` are different rows (the collision `uploads.ts` records for its own
content address); `\u0000` stands for a missing value, so a null is not the four-letter string
`"null"`, which a `str` column of somebody's annotation base very plausibly contains. Both are
mutation-checked, because both fail as a *plausible wrong table* rather than as an error.

**Not Group By**, which is the neighbouring control and collapses rows into an aggregate. This
keeps whole rows, so every column comes through with the value it had; that difference is what
stops the two being one node with a mode.

The R emitter is the one place in that file that leaves dplyr, and it says why: `distinct()` keeps
the **first** row and has no argument for the other two, where `duplicated(..., fromLast = TRUE)`
is exactly `last` and OR-ing both directions is exactly `none` — one idiom covering all three,
preserving row order, and needing no library. Python is `drop_duplicates`, with `subset` **omitted**
rather than passed empty: `subset=[]` compares on no columns, which makes every row a duplicate of
the first.

## Upload Table and Table from URL: somebody else's data

`core.uploadTable`, added from `Add ▸ Utility ▸ Upload Table`. A CSV of annotations, custom cell
types or an embedding, brought in from the user's own machine — the one node here with no inputs
and no data source behind it. `src/data/uploads.ts` is the module to read first; everything below
follows from the two decisions taken there.

**The rows never enter the `.coda.json`.** The node stores a `dataId` and the filename it came
from; the table itself lives in IndexedDB. Three constraints force it and each one alone would be
enough: `stableStringify` re-hashes a string param on **every** graph edit (CLAUDE.md already
flags a 110 kB Explore selection as a stutter risk, and a whole-dataset embedding is megabytes),
the autosave is `localStorage` at a ~5 MB origin budget with `saveAutosave` swallowing quota
failures by design, and a `ParamValue` is `number | string | boolean | string[]` — a table can
only ride in a graph as text.

**So a `.coda.json` sent to a colleague arrives without its rows, and that is the accepted cost.**
It is not hidden: the card says which file is missing and offers to pick it again, and `evaluate`
throws naming the file so everything downstream is `blocked` rather than quietly running on
nothing. The message names the _file_ and never the content hash, because a hash is not something
anyone can act on.

**Its own IndexedDB database, not `data/cache.ts`.** That module is a cache — expiry,
fingerprint-as-miss, and a `cacheClear` that drops everything. A table somebody uploaded is not
evictable; losing it to a cache clear is losing their data. Same call and same reasoning as
`store/library.ts`, and it cannot live beside that one because `src/store` imports `src/nodes`, so
a node reaching into the store would close a cycle. `src/data` is the layer nodes may import.

**Writes reject, reads resolve**, inherited from `library.ts`. Everywhere else here a storage
failure degrades silently, because failing to _remember_ is not failing to compute; an upload
inverts that, because there is nothing to recompute from once the `File` handle is gone. There is
deliberately no in-memory fallback: something that survives until the tab reloads is not somewhere
to put a file. The write waits for the transaction's `complete` rather than for its requests — a
quota failure lets the `put` succeed and _then_ aborts, so awaiting the request would report an
import that was rolled back.

**`dataId` is a content address, and that is what makes provenance work with no nonce.** It hashes
the schema and every cell, so re-picking a file you already imported produces identical params and
re-runs nothing, while a file differing in one value invalidates everything downstream. Two nodes
given the same file share one stored copy. Note the separator: the hash walks a joined string, and
without one a column holding `['ab', 'c']` and one holding `['a', 'bc']` both concatenate to
`abc`, so two genuinely different imports would share an id and the second would silently resolve
to the first one's rows. It is written as `'\u001f'` rather than typed, because a raw control
character in a source file is invisible to every reader and to `grep` — this cost a debugging
round trip when one arrived in the file by accident.

**`fileName` is `presentational`, which looks wrong on a param that is not a viewer knob.** It
cannot change a byte of what `evaluate` returns — `dataId` decides that, and two people importing
one file under two names hold identical rows. Leaving it in the provenance key means renaming a
file re-runs the node and stales everything after it for a reason nobody could see.

### The peek, and why `ID column` is an enum

The schema is not in the graph either, so `inferOutputs` — synchronous, and forbidden to fetch by
invariant 2 — reads `peekUploadSchema`, which answers from an in-memory mirror and, the first time
it cannot, starts the read that will fill it. Once per id, never once per peek, because inference
runs on every keystroke. When it lands, `reportUploadLearned` fires and `graphStore` re-infers
through the _same_ `afterSourceLearned` handler the dataset listings use: this is not a
data-changed event, must not schedule a run and must not autosave, all of which that handler
already gets right for exactly the same reasons.

So on a cold load the node publishes a bare `T.table()` for a moment — typed, so the wire still
connects — and fills its columns in a millisecond or two.

**That window is why `ID column` is an `enum` and not a `column` param.** An enum's stored value
reaches the provenance key verbatim; a column param's is _resolved_ against the available schema
first. Resolved against an empty schema and then against a full one, the node would key one way
before the peek landed and another way after — marking a node that had just run stale, and
invalidating everything downstream of it, on every single reload. `resolveColumn`'s rule 2 keeps a
chosen name and would have survived it; `resolveColumns` drops what it cannot find and would not.

**A miss is announced too.** Without that the card sits on "looking for the stored rows" forever,
and that is the one state that has to resolve into a sentence telling somebody to pick the file
again.

**The card's `useSyncExternalStore` snapshot is a revision counter, not the peeked value.** Both
"still looking" and "not in this browser" peek to `undefined`, so a snapshot of the value is
identical either side of the read landing and React never re-renders. Same idiom and same reason
as the store's `runVersion`. A test drives this; it is not otherwise observable.

### Reading the file

`data/csv.ts`, headless, the counterpart to `ui/export.ts`'s CSV writing. Everything is decided
from the text — delimiter, header, and each column's dtype — and there is **no options
argument**, deliberately. The settings a caller might pass are exactly the ones that would have to
be _stored_ to be honoured on a later run, which puts them in the provenance key and makes the
node's stored schema something that can drift from its stored rows. Detecting once at ingest and
keeping the finished table means the two cannot disagree; the cost is that a file whose shape is
undetectable has to be fixed rather than configured.

- **The delimiter is judged on consistency, not on count.** Counting occurrences picks the comma
  out of a tab-separated file whose text fields contain commas. A real delimited file splits every
  row into the same number of fields, so the candidate producing one field count across the sample
  wins. Semicolon and tab are not exotic: a spreadsheet saving "CSV" under a comma-decimal locale
  writes semicolons, and `to_csv(sep=)` writes tabs.
- **A header is text, and that is the whole rule.** The moment any field of row one parses as a
  number, that row is data. Both obvious extra conditions are wrong: _blank_ names cannot
  disqualify it, because `to_csv()` with an index writes `,a,b` and every such export would be read
  as headerless; _duplicated_ names cannot either, because `uniqueNames` already suffixes them and
  demoting the row instead puts the word "type" into the first row of the column it was naming. The
  remaining ambiguity — an all-text file with no header — resolves _towards_ a header, the same bias
  `pandas.read_csv` takes.
- **A blank cell is null, never zero.** `Number('')` is 0, which draws a dense stripe of data
  nobody recorded along every axis downstream. Same trap `numeric()` in `encoding.ts` exists for.
- **A value that would not survive a round trip stays text.** `007` and `0012` are how a
  zero-padded code is written and reading them as 7 and 12 loses what made them identifiers; an id
  past `Number.MAX_SAFE_INTEGER` comes back a different number. The load-bearing half is that this
  vetoes the _numeric_ reading and not merely the integral one — without that `007` fails the
  integer test, passes the float test, and arrives as `7` anyway. Floats are exempt: `1.50` and
  `1.5` are the same measurement, where an integer's digits are identity.
- **One stray value keeps the whole column text.** A column that is 99% numeric with an `n/a` in
  it is a text column with a convention in it, and reading the rest as numbers drops that row's
  value silently.
- **`0`/`1` are integers, never booleans.** A synapse count of 1 is not `true`, and nothing in the
  text says which was meant.
- **Ragged rows are padded and reported, never dropped.** A trailing comma is routine in a
  hand-edited file, and losing the row silently is worse than a null in it. The count goes through
  the card's error channel once, at import, rather than becoming a permanent badge — it is a fact
  about the import, not about the node's configuration.

**The ceiling is checked against `file.size` before a byte is read** (`MAX_UPLOAD_BYTES`, 50 MB),
which is the same call `pivotTable` makes when it checks label cardinalities rather than the array
it is about to allocate. By the time a table exists the tab has already stalled.

### The two controls

Both are applied _after_ parsing and both are lossless, which is what lets them cost no re-parse
and never disagree with the rows already stored. The pair lives in `tableOps.ts` as
`uploadShapeSchema`/`uploadShapeTable`, with `uploadIsNeurons` shared between them so the schema
half and the value half cannot disagree about the _kind_ either.

- **`ID column` renames the chosen column to `neuronId`**, and the output becomes Neurons. Nodes
  address columns by name — `out.profile` validates on it, Connectivity and Skeletons read it — so
  a file whose author wrote `root_id` cannot meet neuron data until it is renamed. A column that
  merely already held the name is suffixed (`neuronId_2`), the same call `joinedColumns` makes. Only
  `i64` and `str` columns are offered: a float is a measurement and a boolean is a flag, and
  offering either invites a Neurons table whose neuron ids are neither.
- **`Text columns` widens a column to `str`**, and never the reverse. Reading text as a number is
  where data is lost, and the parser's round-trip rule has already kept anything ambiguous as
  text — so this is for a column that is genuinely numeric and genuinely not a _quantity_, like a
  cluster label or a layer index, which has no business offering itself to a size encoding or being
  averaged. Null stays null: `String(null)` is the four-letter word "null", which would read as a
  value everywhere downstream.

`ColumnSchemaSource` grew a second argument for `Text columns` — see the Explore section, where it
came from. A column picker on a node with **no inputs at all** has nowhere to read a schema from
but the node's own params, which is what that argument supplies.

**`cheap`, despite reading a database.** `evaluate` is one IndexedDB read of an already-parsed
table and no parse at all, and there is no upstream, so it re-runs only when its own params change.
Same reasoning as `out.neuroglancer`.

**Known limit: nothing collects orphans.** Deleting the node leaves its rows in IndexedDB, because
nothing can tell whether another graph on the shelf still references them — and content addressing
means re-importing the same file reuses the entry rather than adding one. A "manage uploads"
surface is the answer when there is one; silently deleting somebody's data on a node delete is not.

### The URL variant

`core.tableFromUrl`, `Add ▸ Utility ▸ Table from URL`. The same CSV, fetched rather than picked.
It shares the parser and the shaping pair, so the two nodes cannot drift on what a delimiter, an
ID column or a text column means, and differs in exactly one property: **a URL is reproducible
and an upload is not.** So this one needs no storage at all — the graph carries the address, and
a colleague opening the file re-fetches it. What it gives up is working on a file that only
exists on somebody's disk, behind a login, or on a host sending no CORS headers. Neither node
supersedes the other, which is why both exist.

**`expensive`, which is invariant 6 in its plainest form.** The URL is a text field. Marked
`cheap` it would fire a request per keystroke, at whatever host was half-typed.

**`refresh` is not decoration.** A file at a URL can change under a fixed set of params, which is
exactly the hidden mutable state invariant 4 requires an explicit nonce for — the Dataset node's
own `refresh` is the precedent. Without it, re-running against an updated file hands back the old
table from cache with nothing to say so.

**The schema is remembered per URL, in a module map, rather than observed.** `observesOutputSchema`
is the obvious fit — the shape is decided by a remote server that inference may not call — and it
is _almost_ right. What rules it out is `Text columns`: a `columns` param finds its options
through `schemaFrom`, which is handed the node's inputs and params and deliberately **not**
`ctx.observed`. Widening it to see the observed schema would have inference resolving that param
against a schema the _scheduler_ cannot see when it computes the provenance key and resolves
`ctx.columns` — invariant 5's exact desynchronisation. A map keyed by URL is readable from all
four callers at once. Same lifetime as an observed schema (empty before the first run and after a
reload), same announcement idiom, and session-scoped on purpose: what a server returned is not a
fact about the document, and persisting it would let a saved graph claim columns nobody fetched.

**A cross-origin refusal and a dead host are the same `TypeError`**, because that is all a browser
gives — the constraint `data/precomputed/transport.ts` works around by trying and remembering.
So the message names _both_: the fix for one is nothing like the fix for the other, and saying
only "network error" sends somebody to check their wifi over a header their server never sent.
No proxy is offered, deliberately: `deploymentProxy` in `vite.config.ts` exists under a rule
refusing anything but https to a public host, and a general-purpose fetch proxy is an SSRF hole
aimed at whoever is running the dev server.

**`Content-Length` is checked before the body is read**, and the parsed length again after,
because a chunked response declares nothing. **A 200 that parses to no rows quotes what arrived** —
overwhelmingly a login redirect or a permissions page served as HTML, where "no rows" alone sends
somebody to inspect a file that is perfectly fine.

**`validate` warns about `http` rather than refusing it.** Whether it is actually blocked depends
on how this app is served, which is not knowable at edit time — the same call `Find Neurons` makes
about `limit: 0`. A scheme that cannot be fetched at all (`file:`, `javascript:`) is refused by one
rule rather than by a list of special cases.

## Select One: stepping through a collection

`core.selectOne`, `Add ▸ Transform ▸ Select One`. Forward and back through a table's rows, a
skeleton set or a mesh set, emitting the element you are looking at. The manual counterpart to
the `For each` in the TODO list — that would apply a sub-workflow to every element and collect
the results; this walks the same collection by hand. `Explore → Select One → Skeletons → 3D` is
the shape it exists for: one neuron of a result at a time, without editing a filter for each.

**Two indices, because browsing and deciding are different acts.** `index` is what the card is
showing and is presentational; `selected` is what the port carries and is not. That is Profile's
pager/pin split exactly, and it is here for the same reason: on a chain with an expensive node in
it, an arrow button that fires a full pass per press — and with auto-run on, fires it
_automatically_ — is not a browsing surface, it is a way to spend ten minutes of queries on a
gesture.

**`Live` is the opt-out, and it is presentational too.** Off, the arrows move `index` alone and
`Use this` commits. On, they move both, so the output follows the arrows — which is what anybody
wants on a cheap chain and exactly what they do not want on a costly one. The flag changes
nothing about what `evaluate` returns: `evaluate` reads `selected` and has no opinion on how it
got there. So it stays out of the provenance key, and toggling the mode invalidates nothing —
the same call `Download` makes about every one of its params. `selectOne.test.ts` asserts all
three flags through the scheduler _and_ on the params, because dropping one fails no type check
and the symptom (a graph going stale whenever somebody browses) reads as a scheduler bug.

**The choice is a position, not an identity, and that is a trade rather than an oversight.** An
index works on everything — a `groupBy` roll-up with no id column, an uploaded CSV of embeddings,
a mesh set — where the id-keyed selection `rowIds.ts` provides (Scatter's and Profile's) survives
an upstream re-sort but needs a column naming each element. What it costs is that reordering
upstream re-points the output. What it must not cost is a _silent_ wrong answer, which is why an
index past the end emits the **empty collection** rather than clamping to the last element: an
upstream filter that shrank the collection has not moved the choice, it has removed it, and
clamping would answer with a different neuron under the same number. Emptiness is a state every
downstream node already handles; a different neuron wearing the same index is not. The card says
so in words, naming the position and the length — "emitting nothing" alone reads as a broken node.

**`any` in, `any` out.** The type system cannot say "a table, skeletons or meshes", so the port
says `any` and the refusal is a validation question — the same call `out.profile` makes about
needing a `neuronId`. The output type is the input type untouched, so one row of a Neurons table is
still Neurons with the same columns and nothing downstream loses a column picker.

### What an iterable is

`nodes/lib/iterables.ts`, headless. Three value kinds are collections of independently meaningful
things: a table is rows, a `SkeletonsValue` is neurons, a `MeshesValue` is neurons.

**A `PointsValue` is deliberately not one.** It is the same shape — positions plus one attribute
row each — and stepping through it one synapse at a time is not a gesture anybody makes. That is
a judgement about the data rather than about the type, which is why the exclusion is a named list
rather than something falling out of a structural test.

**Taking one element preserves the kind and the schema**, which is what lets `inferOutputs` be a
pass-through. Only the counts change. The one thing that must **not** pass through is `bounds`:
they are a roll-up over the geometry, exactly as `degreeIn`/`degreeOut` are roll-ups over a
network's links, and a single skeleton still claiming the box of the twenty it came from frames a
3D viewer on empty space around it — which reads as a broken renderer rather than as a selection.
Same rule and same reason as `filterNetwork` recomputing its degrees. `detail` _is_ carried
through, because the level of detail is a fact about the fetch and taking one neuron out does not
re-fetch it.

`isIterableKind` is exported and used by both the node's `validate` and the card's foot line —
one list rather than one per caller, because two copies is how a node starts refusing a kind its
own card still offers to step through. `any` counts as steppable there: unknown is not a refusal,
the same distinction `columnSchemaFor` draws between an absent schema and an empty one.

### The card, and two things jsdom could not see

`SelectOneBody` is the pager, the commit button and the node's one non-advanced param. The foot
line is the whole of the design's honesty: with `Live` off, what is on screen and what is on the
port are two different elements for as long as somebody is browsing, so it always states which
element is being emitted.

Both of the following were found by pointing a real browser at it, and both are now pinned by
`selectOneBody.test.tsx` — which is the point, since neither throws:

- **"Connect a table" appeared on a card that was plainly wired.** Whether something is
  _connected_ is a fact about the graph and comes off the inferred **type**, which exists the
  moment the link is drawn; what is _on the wire_ is a fact about the last run and is absent
  until there has been one. Reading the second for the first sends somebody to fix a link that is
  already there — the same failure the exporter's unwired/blocked split exists to avoid. It now
  says `Not run yet.`
- **The Live checkbox was labelled twice.** `ParamField`'s checkbox draws its own label under the
  default `node` variant, and the generic card suppresses the row's label in **CSS**
  (`.param--wide .param__label { display: none }`) — so a body rendering both got "Live Live".
  The fix is `variant="inspector"`, which is what `ParamRows` already does and documents;
  borrowing the CSS half instead would drop the one boolean row out of the label column every
  other field in these bodies shares. jsdom applies no CSS, so the label **count** has to be
  asserted rather than looked at.

**One pre-existing bug came with it.** `.list-body` carried no padding, so all three cards using
it had their first few pixels painted over by `.coda-node::before`, the state bar down the card's
left edge — "ID column" read as "D column" on Input IDs and had done since it was written. It now
takes the same `calc(8px + var(--state-bar))` inset `.coda-node__params` does: a custom body
replaces the param band, so it has to replace its padding too.

**The Python emitter slices, never indexes.** `df.iloc[[i]]` and `nl[i]` both raise past the end
and both hand back a Series / a single neuron rather than a collection of one — where Coda emits
an empty collection of the same kind, and emits a collection either way. `[i:i+1]` is the one
spelling reproducing both, in pandas and in navis alike; the emitter branches on `ctx.inputType`
because a `NeuronList` takes it directly where a frame needs `.iloc`. The fixture carries **two**
Select One nodes for exactly that reason, or the golden file records only the half that happens
to be a DataFrame.

## Stack Tables: the vertical Join

`core.stack`, `Add ▸ Transform ▸ Stack Tables`. `Join` widens a table with columns from another;
this lengthens one with rows from another. Two connectivity results from different seeds, a
hand-curated list added to a query result, the same analysis run on two datasets.

**Every column survives, and a gap is a null.** A column only one side carries is filled with null
for the other's rows — which is what null already means here: not recorded. The tidier
alternative, keeping only the columns both have, silently discards data that was wired in, and on
two neuron tables from different datasets that can be most of the columns with nothing on screen
saying so. Same call `Join` makes when it suffixes a colliding name rather than dropping it.

**A dtype clash is refused, not reconciled.** `neuronId` as a number above and text below is two
different columns wearing one name. Widening both to text keeps every value and removes the column
from every numeric picker downstream; coercing text to a number loses values outright
(`Number('n/a')`). Neither is a decision this node has grounds to make, so it names the column,
both readings, and stops. `i64` and `f64` are the exception and merge to `f64` silently: those are
the same kind of thing, and a count stacked onto a ratio is still a number.

The clash is **returned rather than thrown** by `stackColumns`, because both halves need it and
neither may throw — `inferOutputs` must not (invariant 2) and `validate` returns strings. Only
`stackTables` refuses, on exactly that list.

**A unit rides along only while both sides agree on it.** Nanometres stacked onto voxels is a
column with no single unit, and carrying one of them would label the other's rows wrongly.

**Rows keep input order and duplicates are kept** — `UNION ALL`, not `UNION`. Which of two
identical rows to keep is a real question with its own answer, and it belongs in the node that
asks it.

**Unknown until _both_ sides are known.** The result's column set depends on both, so publishing
the top's schema alone would advertise a table missing every column the bottom contributes, and a
picker downstream would be configured against a shape that never arrives. A dtype clash still
publishes the union using the top's reading — nothing is built from it, since `evaluate` refuses
on the same list, and it keeps the other columns pickable while somebody fixes the one that
clashes.

**Neurons only when both inputs are.** A `neurons` kind is a claim that the ids are neurons of a
dataset; a plain table that happens to carry a `neuronId` never made it. The type half and the value
half decide it the same way.

**Two inputs, chained for more**, exactly `Join`'s shape. Note the consequence for the source
column: it distinguishes the two inputs of the stack that _added_ it, so three tables want either
a distinct name per level or the labels set at each one.

**The source column is off by default and refused on a collision.** Empty adds none; a name adds a
`str` column holding `Top`/`Bottom`, or whatever the two labels say. Appended **last** rather than
first — it is this node's annotation, not part of either table, and pushing every real column one
place right on every stack reads as the data having moved. A name either input already uses is
refused rather than suffixed: the point of the column is to say where a row came from, and quietly
writing that into somebody's existing column is worse than untidy. The labels are `visibleIf` the
column is named, so naming the inputs of a stack that is not labelling anything cannot stale it.

Worth knowing that a genuine clash is reachable with nothing but built-in nodes, which is what
`stack.test.ts` uses: `core.pivot`'s wide table types its label column `str` even when pivoted
from an `i64`, so a pivot on `preId` stacked onto the connectivity table it came from disagrees
about exactly that column. Note also that the pivot publishes no schema until it has run, so
`validate` cannot see that clash at edit time and does not pretend to.

## Download: a side effect in a reactive graph

`out.download`, `Add ▸ Utility ▸ Download`. Write whatever arrives on the wire to a file. The one
node here whose _purpose_ is a side effect, and everything odd about it follows from that.

**`evaluate` does not download.** It passes its input through and nothing else. Two reasons, and
either alone would settle it: `src/nodes` is headless, so there is no `URL.createObjectURL` and no
anchor to click; and a cache hit means `evaluate` never runs, so a download performed there would
fire on the first Run and silently not on the second. `ui/useDownloads.ts` writes the file,
watching `lastRun.executed`.

**`expensive`, for a reason that has nothing to do with speed.** Nothing here is slow. But `cheap`
nodes re-run on the 180ms pass after every edit, and a node that writes a file per keystroke is
not one anybody can leave on a canvas. It also makes the signal reliable: only `runFull` records a
`RunSummary`, so the driver has something to watch.

**The signal is `executed`, never the output value.** A node that did not re-run is not in that
list, so a Run over an unchanged graph writes nothing — which is the whole of what bounds "on
every run". Watching the value would fire on a cache _restore_ too, writing a file for a graph
nobody re-ran.

**What it does not bound is auto-run.** With that on, every edit that changes the data upstream is
a full pass, and each writes a file. The card says so beside the checkbox, and that warning can
only live there: it depends on a **store** setting, which a node definition must never read, so
`validate` cannot express it.

**Every param is `presentational`, and that is the word used precisely.** `presentational` means
"cannot change what `evaluate` returns", and `evaluate` returns its input unchanged whatever the
filename, format or timestamp say — those decide what is _written_. Leaving them in the provenance
key made renaming a file re-run the node and invalidate the entire graph downstream of it, which
on an expensive pipeline is minutes of queries for a change to a string. The consequence, and it
is asserted rather than left implicit: **changing a setting and pressing Run writes nothing**,
because nothing re-executed. The card's button is what covers that, and is the reason it exists
beyond convenience.

**The driver is mounted in `Editor`, not in the node's card.** A collapsed card unmounts its body,
and a Download node that stopped writing when somebody tidied it away would be a bug nobody could
reproduce on purpose. It carries the mount-seeded guard `paletteRequest` uses, or a remount would
re-fire the last run's downloads — a file appearing because a panel was toggled.

### Pictures come from a viewer, not from the wire

A viewer is a **tap**: `out.scatter` passes its table on, never its picture, so nothing arriving on
this node's input could be an image. `svg`/`png` therefore read the rendered chart belonging to
whatever node _feeds_ this one, found from `graph.edges` rather than from a param — the wire
already names it.

**Reading the DOM would not work, and that is why `exportRegistry.ts` exists.** The heatmap and the
bar chart render a real `<svg>`, but the scatter draws to a canvas and the network to WebGL, and
both **synthesise** an SVG on demand (`scatterDraw`, `networkToSvg` over sigma's post-reducer
display data). Their picture has no element to query, so the viewer's own accessor is the only
route.

**The node id travels by context, not by prop**, which keeps this to two touch points instead of
sixteen: `ValuePreview` is the single place that dispatches to a viewer and already knows the node,
and `ViewerActions` is the single place every viewer converges on with its export source in hand.
`ValuePreview` is wrapped rather than having a provider at each `return` — it dispatches through
fourteen of them, and one missed would leave exactly one viewer unreachable with nothing failing to
say which.

The limit is real and the card states it: SVG and PNG work only while the upstream card is on
screen and not collapsed. Last registration wins, which is the useful way round — the overlay is
mounted last and largest, and is the one anybody asking for a PNG means.

### Formats

`ui/exportValue.ts`, and the rule is that **nothing is ever refused for want of a format**: a kind
with no natural text form falls back to JSON. An _explicit_ format the value cannot be written as
plans nothing and is reported, because silently falling back would hide that the choice did not
apply.

- **Table, Matrix, Points → CSV.** A point cloud keeps its positions with its attributes, since
  splitting them loses the row-for-row correspondence that makes it a point cloud.
- **Network → two CSVs**, nodes and links. One file cannot hold both without inventing a shape
  nothing reads; two is what the Network viewer's own button gives and what Gephi imports.
- **Skeletons → SWC, Meshes → OBJ, one file per neuron.** A concatenated SWC has repeating ids and
  parses as one impossible tree. `MAX_MORPHOLOGY_FILES` caps the set at 50 and the plan _reports_
  the cap: a browser stops honouring downloads past roughly that many with no error, which reads
  as the export having half-worked.
- **Anything → JSON**, with typed arrays unpacked. `JSON.stringify` renders a `Float32Array` as an
  object keyed by index — valid, unreadable, several times larger — and every geometry value here
  is built out of them.

Two format details that produce a _valid file that is wrong_, which is why both have tests:

- **SWC ids are 1-based and a root's parent is `-1`.** Coda stores parents as array indices, so
  every one shifts. A 0-based file parses in every tool and hangs the first point off nothing. The
  structure identifier is written as `0` throughout rather than guessed — neuPrint publishes no
  soma/axon/dendrite labelling, and marking the root as soma would be a claim about anatomy the
  data does not support.
- **OBJ face indices are 1-based.** A 0-based file loads with one corrupt triangle and a stray
  vertex at the origin, which reads as a renderer bug rather than a bad export.

`downloadFiles` writes a multi-file set in a plain loop rather than staggered: browsers gate
multiple downloads from one gesture behind a permission prompt, and spacing them with timers loses
the gesture and gets them blocked outright instead of asked about once.

### One knock-on in the palette

An `any` **output** is excluded from the palette's backwards link-drag, and the asymmetry with the
input is the point. `any` on an input means "I accept whatever you have", which is a real answer to
"what could this feed?" — Download genuinely takes anything. `any` on an output means "whatever I
was given": a pass-through cannot _originate_ a Dataset, so offering it when dragging back from a
Dataset socket answers the question with a node that needs the same question asked again behind it.

## Connectivity: hops and direction

`Direction` offers `both`, and `Hops` traverses further than one synapse. Both changed what the
node _emits_, which is the part to read before touching it.

**The output is an edge list, not a partner list.** Columns are `preId`/`preType` →
`postId`/`postType`, plus `hop` and `direction`. Every row is oriented the way the synapse
points, always, so `Build Network` with source `preId` and target `postId` is correct for every
combination of params with nothing to think about. The old query-relative shape
(`neuronId` = the neuron you asked about, whichever way the arrow went) cannot survive either
addition: a `both` result mixes in-edges and out-edges, so half a network's arrows come out
backwards, and past one hop "the neuron you asked about" is not a thing a row can name — it is
whatever the previous hop reached.

**The `DataSource` seam did not change, and that is deliberate.** `fetchConnectivity` still
answers query-relative, because the Profile widget reads it directly through
`profileStats.ts` — "these are my upstream partners" is the right shape there and the wrong
shape here. The reorientation lives in `nodes/lib/connectivityOps.ts`, i.e. in the node.

**`hop` and `direction` are always present**, even at one hop downstream where they are constant.
A schema that gained and lost columns as Hops moved between 1 and 2 would silently clear every
downstream column picker pointing at them.

The rename is a breaking change and was taken as one: both bundled examples group by
`preType`/`postType` now, and a graph saved before this loses its column params on those two
names. Nothing repairs it — `validateColumnParams` reports the drift and the picker is re-chosen.

**`both` expands both ways at _every_ hop — the undirected ball, not two cones.** That is what
finds the neurons sharing input with a seed (up then down) and its co-inputs (down then up),
which is usually why anyone asks for two hops in both directions. The cost is that the frontier
grows by in-degree × out-degree per round.

**Edges are deduplicated on (pre, post), and that is not tidiness.** With `both`, an edge inside
the frontier comes back from each end, and `Build Network` sums the weight of every row joining a
pair — so a duplicate row is a doubled synapse count in the picture. `direction` is `both` when an
edge was reached from each end **at the same hop**, which on a seed set is exactly the set of
edges internal to it. An edge re-found at a later hop keeps the direction and the hop it was first
given; otherwise the label would drift with traversal order rather than saying anything about the
graph.

**Neurons are expanded at most once.** Connectomes are full of recurrent loops, so a BFS that
re-expanded a visited neuron would not terminate. The _edge_ back into a seed is still reported;
only the neuron is not re-queued.

**`minWeight` is the only throttle, and it prunes rather than filters.** It is applied by the
source, so an edge below it is never returned — which means it is neither a row nor a reason to
expand. Three hops at weight 1 is a genuinely large question and is asked as one; `validate` says
so above three hops as a **warning**, never a refusal, the same call `Find Neurons` makes about
`limit: 0`.

**Iterative frontier queries, not a variable-length Cypher path.** `-[:ConnectsTo*1..N]->` is one
round trip and was declined: it hands the whole expansion to a shared production Neo4j with no
chance to prune between hops, it would put a `hops` field in `ConnectivityRequest` for a concern
no source should own, and `MockSource` would need its own BFS regardless. Looping
`fetchConnectivity` instead means no source changed at all, the mock works for free, the BFS is
testable against a fake graph with no network, and progress can report per round.

**Known limit: the frontier is inlined into the query.** `idList` puts every id in an `IN`
list, so a hop-2 frontier of tens of thousands of neurons builds a very large Cypher string. Not
chunked, because chunking is only worth writing once a real query has actually failed on it — but
it is the first thing to suspect if a deep traversal errors at the transport rather than timing out.

## Paths: how does this reach that?

`neuron.paths`, added from `Add ▸ Query ▸ Paths`. `Connectivity` answers "what is wired to
this?"; this answers "how does this reach that?", which is a different query with a different
result. Three outputs: a **Network** already pruned to the feed-forward connections on a route,
the **Layout** for it, and a **Paths** table of one row per route.

**The traversal runs on the collapsed graph, not on the neuron graph it was collapsed from.**
This is the decision everything else follows from. With `Collapse types` on (the default), `LC4`
is one node, a hop expands _every_ LC4 neuron, and the result is aggregated back to types before
anything is pruned or expanded again. So `LC4 → PLP1 → DNp01` is found even when no single PLP1
neuron both receives from an LC4 and projects to a DNp01 — which is usually the circuit somebody
means, and is **not** recoverable by collapsing a neuron-level result afterwards, because the
neuron-level search would never have returned either edge.

The knock-on is that **`Min synapses` is a threshold on type-level traffic**, a much larger
number than any one connection carries, and it is applied _after_ the `sum` rather than before.
Cutting each synapse group first would discard the many weak connections that are exactly what
adds up to a strong pathway.

**So the aggregation has to happen in the backend**, which is what `DataSource.fetchPathStep`
and `PATH_STEP_SCHEMA` are for. A type-level hop on male-CNS touches every neuron of every
frontier type and collapses to a few hundred rows; doing that client-side would mean
downloading the former to compute the latter, per hop. `pathStepCypher` does it in one `WITH`.

**The frontier is two lists, not one.** A neuron with no type stands as its own node — there is
nothing to collapse it into — so a frontier is a mix of type names and neuron ids, and
`sourceId`/`targetId` are null exactly when the key names a type. Both halves of the `WHERE`
are then index-backed, where a `coalesce(n.type, toString(n.bodyId)) IN [...]` would express the
same set and force a label scan of every `:Neuron` in the dataset.

**Both ends of a path step are `:Neuron`, unlike a connectivity fetch.** `connectivityCypher`
deliberately matches the far end as a bare node so a `Segment` below the neuron threshold still
counts towards a total. A route _through_ an unnamed fragment is not a circuit anyone traced,
and the fragment would be expanded at the next hop. Reporting a total and tracing a route want
different sets.

**The search is bidirectional, and that is what makes four hops askable.** Forward `⌈h/2⌉` hops
from the sources, backward `⌊h/2⌋` from the targets. Every edge of every route within the budget
is still covered — the edge at position p is reached forwards when `p ≤ ⌈h/2⌉` and backwards
otherwise, since then `L − p ≤ ⌊h/2⌋`. Each hop multiplies the frontier by the average partner
count, so halving the depth square-roots the work.

**A route's strength is its bottleneck**, the weakest link along it, and `N strongest` keeps
whole _routes_ by that measure. Summing was considered and is wrong for the same reason it is
wrong in `BuildNetwork`: it prefers a long chain of large numbers with a 2-synapse step in the
middle to a short one where nothing is weaker than 40. A bottleneck is also comparable between
routes of different lengths, which a sum is not — and the ranking deliberately spans lengths, so
a strong 3-hop route beats a weak 2-hop one.

**neuprint-python's `fetch_shortest_paths` was considered and declined**, and it is worth
knowing why, because it is the reference implementation and it _is_ the more efficient shape
for the question it asks:

```cypher
MATCH (src:Neuron {bodyId: X}), (dest:Neuron {bodyId: Y}),
      p = allShortestPaths((src)-[:ConnectsTo*]->(dest))
WHERE ALL (x IN relationships(p) WHERE x.weight >= $min)
RETURN [n IN nodes(p) | [n.bodyId, n.type]], [x IN relationships(p) | x.weight]
```

One round trip, and — the real win — no frontier inlined into the query, which is this node's
one known weakness at neuron level. It fails on two counts here, both of them semantic rather
than technical. `allShortestPaths` returns **only** shortest routes, so it discards the strong
3-hop route the moment any weak 2-hop route exists, which is the ranking's whole point. And it
walks `:Neuron` nodes, so it cannot run the _default_ mode at all: collapse-first needs the
traversal on the type graph, and Cypher cannot walk a derived graph without GDS. Its 5s default
timeout is also an admission that the query can run long. Do not swap the per-hop loop for it
without changing both of those decisions first.

**Ranking is depth-first with branch-and-bound, not enumeration.** The number of simple routes
is exponential in the hop budget. Bottlenecks only ever fall, so once the shortlist is full any
partial route already no better than its weakest member is abandoned whole; neighbours are
visited strongest-first so the bound bites from the first branch. `toTarget`, computed during
pruning, kills anything that cannot reach a target in the hops that remain.

**`topN: 0` means "as many as are worth listing", not literally all of them,** and that was got
wrong first. Eight layers of nine nodes is five million routes, each an array. Worse, with no
shortlist there is no _bound_, so the search degenerates into the full enumeration the
branch-and-bound exists to avoid — the first version of this hung the test run rather than
returning slowly. `MAX_PATHS_KEPT` caps it and `truncated` says so. The shortlist is a heap
keyed by the same comparator the final sort uses, because it is consulted on every branch: a
sorted array re-sorted per insertion is what made the `topN: 0` case quadratic.

**Pruning is what makes the network feed-forward, and it is an inequality rather than a rule.**
A node survives when `fromSource + toTarget ≤ maxHops`, an edge when
`fromSource[u] + 1 + toTarget[v] ≤ maxHops`. An edge running against the flow, or between two
nodes at the same depth with no way onward, fails it. Both distances are measured on the
_collected_ graph and that is exact rather than approximate here, precisely because of the
bidirectional coverage above.

**The network spans the kept routes, not the pruned graph.** A node reachable within the budget
but not on any route that survived the ranking is not in the picture — otherwise `N strongest`
would silently mean "N routes listed, everything drawn". `paths` on each node and edge counts
how many kept routes run through it, which is the nearest thing to a betweenness available for
free and reads well as a size encoding.

**No route is an answer, not an error.** "These two are not connected within N hops at this
threshold" is a real finding; throwing would block everything downstream from ever drawing the
empty result that says so.

**Known limit, same as Connectivity's:** at neuron level the frontier is inlined into each
query, so a deep neuron-level traversal builds a very large Cypher string. `validate` warns
above three hops and warns again when `Collapse types` is off there. A warning, never a refusal
— the same call `Find Neurons` makes about `limit: 0`.

### The Layout output, and `T.layout()`

A new value kind: `{ kind: 'layout', positions: Record<id, {x, y}> }`, with a matching optional
**`Layout` input on `out.network`**. Fixed ELK layered, left to right, in `src/layout/network.ts`.

**A type rather than a table of `id`/`x`/`y`.** A layout is not data about neurons — it is an
arrangement computed _for_ a particular node set. A table would accept any two numeric columns
and fail at run time with a column picker to configure first.

**An input rather than another entry in the `Layout` enum.** Whether positions arrived is a fact
about the wiring, not a choice made in the styling panel: as a mode, the enum would silently
change under someone the moment they connected a wire, and stay changed when they pulled it.
Connected, it wins over the param, and the caption says `layout from input` — a control that
quietly stops doing anything is worse than one visibly overridden.

**It reaches `evaluate` never, and the drawing always.** `out.network` ignores the socket
entirely, so wiring one up invalidates nothing downstream. That is the same standing every
presentational param here has, arrived at by the value never reaching the output rather than by
a flag.

**Given positions are not normalised, unlike every computed layout in the viewer**, and nodes
they do not name fall through to the chosen algorithm rather than stacking on the origin — so a
layout that outlives an upstream filter degrades instead of collapsing. A layout matching
_nothing_ falls back entirely.

**`useStablePositions`, not `useStable`.** The structure effect is the most expensive dependency
list in `NetworkViewer` (`networkRebuild.test.tsx` is the guard), and `nodeInputs` mints a fresh
record on every store tick. `useStable` would `JSON.stringify` two floats per node on every
render; the fingerprint is one pass and no allocation.

**The layout is fixed rather than configurable, and that is the trade.** It is an _output value_,
so a spacing slider would take part in the provenance key and stale everything downstream when
nudged. Restyling is what the Network node's presentational params are for.

**`src/layout/network.ts` is a sibling of `elkGraph.ts` and shares only the engine.** That module
maps editor cards — measured sizes, one ELK port per socket, a fixed port order so wires arrive
in the right handle. A network node is a disc drawn from its centre with no sockets at all, and
its size is whatever the encoding says at render time. So: a nominal box, node-to-node edges,
and **centres rather than ELK's top-left corners**, since sigma places a node at its centre and
corners put the whole picture half a box out. A dangling endpoint is dropped rather than
allowed to make ELK reject the entire graph.

`runElk` is exported from `engine.ts` for this. Both callers get one lazily-loaded engine, and
elkjs still never enters the main chunk — verify with `pnpm build`.

### The caption

`PathsBody` reads the node's own `paths` output and shows `N routes · min H hops · W syn
bottleneck`. A body rather than an entry in `describeValue`, because the footer summary is keyed
to the _first_ output — where "24 nodes · 31 links" is the right thing to say — and because a
body can say "not run yet" in its own words. Not `expandable`: there is nothing here that
benefits from room, and the routes themselves are a table.

## IDs from Label: the inverse query

`neuron.idsFromLabel`, added from `Add ▸ Query ▸ IDs from Label`. Every other query node
narrows a population; this resolves a **named set** — labels in, the neurons carrying them out.

**It is not `Find Neurons` with a different label, and the overlap is worth knowing so nobody
"simplifies" one into the other.** neuPrint's `=~` anchors at both ends, so `LC4|LC6` typed into
Find Neurons' Type field already returns exactly those two types. That case is genuinely covered.
What is not is where the labels actually come from: the `preType` column of a Connectivity result,
a `groupBy` roll-up, a list pasted out of a paper. None of those can be typed into a regex field,
and the node that turned a column into an alternation would be this node with an extra step.

**Labels arrive from two places and they union.** A `Labels` text param and an optional `Labels`
table input with a column picker. Not one overriding the other: both are things somebody asked
for, and a node that silently dropped the text field the moment a wire arrived would look correct
— the result is a valid neuron table either way. `collectLabels` in `nodes/lib/labelLookup.ts`
owns the union, deduplicating with first-occurrence order kept, because that order is what the
unmatched report is printed in.

**`LabelMatch` is a new member of `FindNeuronsRequest`, not a third pattern field.** The seam had
`typePattern` and `instancePattern`, hardcoded to the only two fields anyone had needed; a lookup
on `class` or `hemilineage` would have been that same edit twice more. So the request names the
**property**, which is what lets the field picker read the dataset's _discovered_ neuron schema.
The literal form compiles to `n.\`type\` IN […]`, which neuPrint has indexed — the equivalent
regex alternation expresses the same set and forces a scan of every `:Neuron` in the dataset.

**Empty `values` matches nothing, which inverts the field beside it.** An empty `typePattern`
means "do not narrow", i.e. everything. A lookup of nothing is nothing. A source implementing
`LabelMatch` must not read an empty list as "no filter" — an unconfigured node firing an
unbounded `MATCH (n:Neuron)` at a shared production Neo4j is a hazard, not a default. The node
answers that case without a query at all, returning an empty table _of the right schema_ so
downstream column pickers populate before anyone has typed anything.

**Literal is the default; regex is opt-in.** A label is text somebody copied out of a result, and
`SMP001(a)` and `5-HT` carry regex metacharacters — reading those as syntax turns a lookup into a
different question with no error to say so. Under `regex`, each value is matched with the same
anchored whole-string semantics `typePattern` has, and `MockSource` wraps in `^(?:…)$` exactly as
`compileRegex` does, so the two sides of the seam agree.

**Each regex is matched on its own — `any(p IN […] WHERE n.f =~ p)`, never one alternation.**
`=~` anchors the _whole_ pattern, so folding `LPLC1|LPLC2` into a surrounding `^(?:…)$` splices
its alternation into the outer one and quietly matches a superset of what that entry means alone.
Per-pattern matching gives each entry exactly the semantics it would have in Find Neurons' Type
field, which is the only comparison a user can make.

**Null handling falls out rather than being coded.** A neuron with no value yields `null IN […]`
or `null =~ p`, both null, and Cypher's `WHERE` keeps only true; `toLower(null)` is null too, so
the case-insensitive form needs no guard. The mock reproduces it explicitly — a missing
`hemilineage` is not a match for the empty string.

**There is no `limit`, and its absence is load-bearing.** Every other query node has one. Here it
would make the card lie: the readout reports which labels matched nothing by reading the _result_
back, so a truncated result would name labels as missing that are in the dataset. A lookup of a
named set has a size the question already fixes.

**Status defaults to `Traced`**, as Find Neurons always has, so the same label does not return two
different counts in two nodes. Advanced, so changing it is a deliberate act.

### Reporting what matched nothing

A card readout (`ui/nodes/IdsFromLabelBody.tsx`), derived from the run — **not** a warning
reported by it.

**There is no run-time warning channel, and this deliberately did not add one.** `validate` runs
at edit time with types and no values, so it cannot know what matched. A `ctx.warn` would have to
be carried on `NodeRunInfo` _and_ on the `CacheEntry`, or it vanishes the moment a result is
restored rather than recomputed — a warning that disappears while its result stays is worse than
none. The miss is derivable from what the node already publishes, so it is derived: correct after
a reload, correct from cache, and with nothing new to keep in step. Same reasoning and same idiom
as `PathsBody`. If a second node ever needs this, the channel is the right answer then; one node
is not enough to justify it.

**`unmatchedLabels` refuses in two cases, and the refusals matter more than the arithmetic.** No
result table means the node has not run, so there is nothing to be missing from. A field the
result does not carry means silence — "nothing matched" over a table full of matches is a
specific and wrong claim, where saying nothing is merely unhelpful. (Every source returns the
property it was asked to match on, so the second should not arise.)

**The positive half is shown too**, `1,204 neurons · 18/20 labels`. A line that appears only when
something is wrong is a line nobody learns to look at.

**A custom body replaces the generic param rows outright**, so this one renders the same
non-advanced set the card would have, in declaration order, rather than a chosen few — a control
a body forgets is reachable only from the inspector, which on screen is indistinguishable from a
control that was never added. `idsFromLabelBody.test.tsx` asserts the list.

## Input IDs: the ids themselves

`neuron.inputIds`, `Add ▸ Query ▸ Input IDs`. Somebody has neuron ids from a paper, a spreadsheet
or a colleague. `IDs from Label` resolves a _named_ set; this takes the ids.

**The Dataset input is optional, and that is the whole design.** Unwired, the node emits the ids
as a one-column `Neurons` table and touches no network — already enough for most of what a list
of ids is _for_, since `Connectivity`, `Skeletons`, `Meshes`, `Synapses` and `ROI Counts` all
reach their ids through `idColumn(table, 'neuronId')` and read nothing else off the row. Wired, it
fetches the full neuron rows, which buys the columns every downstream picker wants and — the part
worth having — the ability to say **which ids the dataset has never heard of**, which is how a
mistyped id is caught and is otherwise uncatchable.

**`expensive` either way, because `cost` is a static property of the definition.** A node that
_can_ issue a query must not be `cheap`: the ids are a text field, and `cheap` would fire a query
per keystroke at a shared production Neo4j (invariant 6). So the unwired case pays a Run press it
does not strictly need. That is the right direction to err and cheaper than the only alternative,
which is two nodes doing one thing.

**No status filter, unlike every other query node here.** `Find Neurons` and `IDs from Label`
both default to `Traced` so one label does not return two different counts in two nodes. Here
that would be a quiet lie: an explicit list of ids is an explicit set, and dropping one for its
status would remove a neuron somebody named _and then report it as missing from the dataset_.
Filtering belongs downstream where it is visible.

**The advertised schema changes with the wiring**, one column without a Dataset and the dataset's
whole neuron schema with one. That is the visible cost of an optional input and it is the honest
shape — advertising a `type` column that nothing will ever fill breaks every picker downstream
that believed it. Both branches are exactly what `evaluate` returns.

**`tableFromRows` defaults to `kind: 'table'`, and this node's port says `neurons`.** Passing the
kind explicitly is not decoration: a value whose kind disagrees with its port's declared type is
a disagreement nothing type-checks, and `selectTable` — the one op in the tree that branches on
`table.kind` — would take the wrong branch on a table this node had called neurons.

### Parsing, and what it refuses

`nodes/lib/idList.ts`, the sibling of `labelLookup.ts` and mostly refusals, which is exactly the
difference between the two: a label is free text and anything is a valid one, where an id is a
number and a token that is not one is a mistake somebody just made.

**Separators are whitespace, comma, semicolon — plus brackets and quotes.** The list very often
arrives as `[123, 456]` or `"123","456"`, copied out of a Python session or a JSON blob, and
refusing that paste on a punctuation mark refuses the gesture rather than the content. They are
separators and not _stripped_ characters, which is what keeps `12a` one bad token rather than a
`12` with something quietly discarded after it.

**A bad token refuses the whole list.** Skipping was considered and declined: a list of ids is a
list of neurons somebody means to look at, and dropping one quietly answers a different question.
The cost is real and accepted — pasting a spreadsheet column brings its header — so the message
says _"If you pasted a column, delete its header line"_ when the first token is a word, and only
then. A hint offered where it cannot be true is noise on top of an error.

**A wide id is now kept exactly, and the ceiling describes the data rather than JavaScript.**
This file used to refuse anything past `Number.MAX_SAFE_INTEGER`, on the grounds that `CellValue`
is a JS number so an `i64` column is really a float64 — `720575940379279312` stored as a
_different_ integer, identifying a different neuron with nothing anywhere to say so. That was
right for exactly as long as an id had to become a number on its way to a query, and the day it
predicted has arrived: see invariant 8 above. Ids are now carried as decimal digits,
so there is nothing to lose, and the refusal is a nineteen-digit width — a signed 64-bit maximum,
which is what both Neo4j and CAVE actually store.

Note what did _not_ move. With **no Dataset wired** the ids are the node's own output, and that
table's `neuronId` is an `i64` column, so the width still bites there — `validate` warns and names
the id rather than rounding it, and says to wire the Dataset that was almost certainly meant.

**The wired column drops what it cannot use instead of refusing**, and the asymmetry is
deliberate. Typed text is _authored_ — a bad token is a mistake somebody just made and can fix, so
refusing helps. A wired column is _data_, and a node that refused to run because one upstream row
had a null id would be unusable, which is why `idColumn()` has always skipped them. The card
counts what was skipped so the number is visible rather than the rows merely being absent.

**Ids are deduplicated, first-occurrence order kept.** A neuron listed twice is one neuron, and a
repeated row is double-counted by everything downstream that sums a weight. The order is what the
unmatched report prints in, so a report and the list that produced it read against each other.

**The parse is a pure function returning a message rather than throwing**, which is what lets
`validate` run it at edit time — so a refused list is reported while it is being typed — and lets
`evaluate` raise the _same sentence_. A badge and an error describing one problem differently is
how somebody concludes there are two.

### `FindNeuronsRequest.neuronIds`

A new field at the source seam rather than a `LabelMatch` on `neuronId`, and the reason is not
stylistic: `labelClause` compiles to a list of **string** literals, and `123 IN ['123']` is false
in Cypher — an empty result, with no error anywhere to explain it. `neuronIds` goes through
`idList`, which emits the digits as an unquoted integer literal.

**Present-and-empty means no neurons, never "no filter".** Deliberately unlike the label clause
beside it, which drops itself when empty and so reads an empty set as no filter at all; that is
safe there only because the node guards it. Relying on a future caller's guard for a clause that
would otherwise return the entire dataset is not a trade worth repeating, so this one compiles to
`n.bodyId IN []`. `MockSource` reproduces the same rule, or a node would pass its tests against
the mock and return the whole dataset against the real source.

### The readout

`InputIdsBody` shares a stylesheet block with `IdsFromLabelBody` — `.list-body`, renamed from
`.labels-body` when the second one arrived. The two cards are the same object: a paste target,
the node's other fields, and a line underneath saying what the run did and did not find. Two
copies is how the pair drifts on what that line looks like.

Derived from the run rather than reported by it, same as its sibling and for the same reason:
there is no channel from `evaluate` to a node's badge that survives a result being restored from
cache rather than recomputed, so a warning raised at run time would vanish while its result stayed
on screen.

**The miss is only reported with a Dataset wired.** Unwired the node hands back exactly the ids it
was given, so every id matches by construction and a `0 not found` line would be a fact about
nothing.

## Explore: the browsing widget

The entry point for someone who does not yet know what to ask for. `Find Neurons` is
procedural — state a regex, get a result; `Explore` holds a dataset's **entire** neuron table,
searches it as you type, pages through it and lets you tick individual neurons. `New ▸ <dataset>`
builds `Dataset → Explore → Table`, which is what the start page's dataset rail opens.

**The whole dataset is downloaded once and searched locally.** Fuzzy-matching every field of
every neuron cannot be a query per keystroke against a shared production Neo4j. Measured on
male-CNS v1.0: 165,122 Traced neurons of 176,422 total, × 20 properties = 26 MB of JSON, **6.9 MB
gzipped, ~5 s**; it parses in ~85 ms and substring-scans in ~6 ms. Local search is not merely
viable, it is faster than a round trip could ever be. hemibrain is 186,061 rows in ~3.8 s.

**Cached in IndexedDB, not `localStorage`** — 26 MB is five times the whole localStorage budget.
`data/cache.ts` degrades to an in-memory Map wherever IndexedDB is missing (node, private mode),
because a failure to _remember_ must never look like a failure to compute. The cache fingerprint
is the column list, so an index cached before schema discovery learned about `superclass` is a
miss rather than a table that disagrees with the type being advertised downstream.

**Three ports, and the viewer hangs off the second.** `Hits` is everything matching the query;
`Selected` is only the ticked neurons, resolved against the whole index so refining a search
never drops something already chosen; `All` is the index itself. The starter wires `Table` to
`Selected` because `Hits` with an empty search is the entire dataset.

**`All` is the index handed on unchanged, and it is free.** Neither the search nor `Max hits`
touches it — a port called All that narrowed with the search box is the worst of both — and it
returns the _same_ `TableValue` the loader did rather than a copy, which is only safe because
columns are immutable by contract (`core/values.ts`). The point is that the download is already
paid for: 26 MB of every-neuron-every-property becomes an ordinary table for a group-by or a
chart with no second query against a shared production Neo4j. It sits **last** in the output
list so the two ports every saved graph is wired to keep their socket positions, and so a link
dragged off the node still starts from `Hits`. Note what it is _not_ — an escape from
provenance: a downstream `Filter` on `All` re-runs locally, but Explore itself is still
`expensive`, so the first Run of a session still waits for the index.

**Node `expensive`, widget live — the split is the design.** Typing filters the widget's own copy
of the index immediately and never runs the graph; the committed query lands as a param after a
140 ms debounce, marking the node stale so downstream waits for Run. `cheap` would re-run
everything downstream per keystroke; searching only on Run would make the list feel dead. Paging
is `presentational`, so browsing invalidates nothing.

**Fuzzy is a fallback, not the default.** A term matches as a substring; only when the whole
query finds nothing is it retried as a subsequence, and the result carries a `fuzzy` flag the
caption shows. Running both at once was the first design and real data killed it: `DNp01`
reported **4,389** hits against male-CNS instead of 2. The right ones ranked first, but a hit
count off by three orders of magnitude is its own lie. As a fallback it still catches typos
(`mechnosensory` → `mechanosensory`) without inflating every count.

**Ranking is a bucket partition, not a sort.** Five tiers (exact / prefix / substring in
`type`|`instance`|`neuronId` / substring anywhere / subsequence), so it is O(n) and can rank
_every_ hit. An earlier version gave up above a threshold, which left the real DNp01 neurons
thousands of rows deep in a 21k-row fuzzy set — i.e. "fuzzy search does not work".

Non-obvious rules pinned by tests: a missing value satisfies `!=` and nothing else (so
`status!=Traced` finds the untraced _and_ the unlabelled, where SQL's three-valued logic drops
both, silently); regexes are **unanchored**, deliberately unlike neuPrint's `=~`, because this
search is local and has no server semantic to match; and only `neuronId` and string columns join
the free-text haystack, so `1200` does not match a synapse count.

**A thumbnail cache remembers masks and never refusals.** A mask is a fact about the geometry;
a refusal is a verdict from a policy — the byte ceiling, the multi-resolution requirement — and
policy changes when the code does. Persisting one silently outlived raising
`THUMBNAIL_MAX_BYTES`: every neuron the old 128 kB ceiling had turned down (DNp01 among them)
stayed a placeholder through any number of reloads, because nothing ever asked again, and the
entry carried neither a fingerprint nor an expiry. The session's in-memory map still holds
refusals, which is all that was ever needed to stop a page turn re-requesting; forgetting them
across reloads costs one manifest read. Stored masks now carry a `MASK_FORMAT` fingerprint, and
a stored mask with nothing in it is read as a miss rather than as a refusal — either one alone
retires the bad entries, and `explore.test.tsx` seeds a real one to prove it.

**Thumbnails are the coarsest published mesh, projected.** No token — meshes come from public
buckets, so they work in a static deploy where the Cypher API cannot reach. `thumbnail.ts` is
pure and returns a one-byte-per-pixel **coverage mask**, not RGBA: 9 kB rather than 36 kB, and
carrying no colour it survives a theme switch, which a cached tile with the theme baked in would
not. Triangles are filled and depth-shaded (brightest-wins, so overlapping branches do not
saturate); vertices alone would be a dotty cloud at that level of detail.

**Rasterised at 2× the box it is drawn in** (`RASTER_SCALE`), because the mesh has more detail
than a 76px tile can hold — at 1:1 a thin neurite either landed on a pixel or vanished, and a
HiDPI screen was upscaling the result. The browser downsamples, which is what turns the surplus
samples into antialiasing, so `image-rendering` must stay `auto`. The cost is 4× per cached mask
(23 kB, not 5.8 kB), which is the reason not to go to 3×. The raster size is part of the cache
key, so masks stored at the old resolution are a miss rather than a tile at the wrong scale.

**No visual verification exists for the thumbnails either** — jsdom has no canvas. What _was_
done once, by hand: rasterising real hemibrain, MANC and male-CNS neurons and printing the mask
as ASCII. An LC4 showed its lobula arbor, thin neurite and terminal tuft; male-CNS body 10001
showed the giant fibre's descending axon. That needed a token and a network, so it is not in the
suite.

**Select-all is capped at `MAX_SELECT_ALL` (10,000) and refuses rather than truncates.** A
selection is provenance — it is in the saved file and in every downstream cache key — so
`stableStringify` walks the whole array on every graph edit: 10k neuron ids is ~110 kB per key
computation, the whole of male-CNS is ~1.9 MB and would make typing in an unrelated node
stutter. The button stays rendered while refused (a limit reads as a limit; a missing button
reads as a missing feature) and its title says what to do. The ceiling is on the _click_, not
on the param: ticking rows by hand still can pass it, and a loaded file is never rewritten.

**Which fields become tags is a param, and it is inspector-only.** `chips` is `advanced` (so it
is not on the card — a multi-select above a list of neurons spends the widget's width on its own
configuration) and `presentational` (so restyling a row cannot stale a downstream result).
Empty means "decide for me", which is what the priority list in `rowFields.ts` is for; a
non-empty list is shown **in full and in the given order**, uncapped, because trimming what
someone typed is how a control stops being believed.

That param is also the reason `ColumnParam`/`ColumnsParam` grew **`schemaFrom`**. A column
picker normally reads `attributeSchema` off the type at `from`, and a _Dataset_ socket carries a
source id and a dataset id instead — turning those into a schema needs the data-source registry,
which `src/core` must not import. So the node supplies the lookup
(`schemasFromType(inputs.dataset).neurons`), returning a schema rather than a name list so the
`dtypes` filter, the validation and the picker all keep working unchanged. Resolve it through
`ctx.columns('chips')`, never `ctx.params.chips` — invariant 5 — which is also what drops a
field the current dataset does not have instead of rendering a column of blanks.

It takes the node's **params** as a second argument as well, which `Upload Table` is the reason
for: that node has no inputs at all, so the only place its picker can find a schema is the upload
its own params point at. Every call site already held the params, so the widening cost nothing —
but note what it means, and it is the honest reading of the hatch's original purpose: `from` says
which port must be _connected_, and `schemaFrom` says where the schema actually comes from. On a
node with no ports those are simply different questions.

**A row's chips are tinted by field, and the hue lives in CSS.** `rowFields.ts` assigns each
chip candidate a categorical palette slot keyed to the _field_, so `class` is the same blue on
every dataset and every row; `NeuronRow` emits it as `data-slot` and `--chip-1..8` in
`theme.css` resolve it. Deliberately not computed in JS: a row is memoised, so a hue from
`seriesColor()` would survive a theme switch unchanged, where a custom property re-resolves for
free. `chips.test.ts` guards the resulting duplication. The fill is a 24% tint (label keeps
5.0:1 / 7.1:1, over the 4.5:1 small-text floor) with the hue at full strength on the border.

**The automatic list spends one slot per _fact_, not one per name for it.** A `ChipSpec` can
declare a `family` — `hemilineage`/`itoleeHl`, `consensusNt`/`predictedNt` — and the default
list takes the first member present. Without it a dataset that names one thing twice pushes a
field that says something new off the end of the cap, which is how `consensusNt` disappeared
from male-CNS the moment `itoleeHl` joined `hemilineage` in the list. Only the automatic list
dedupes; a list chosen in the inspector is taken literally, including asking for both.

**A card shows the same tags as the overlay.** There was a cap on chips in `compact`, on the
grounds that a card is a preview, and it was wrong twice: it hid the seventh chip in the one
place the list is actually read, and it truncated an inspector-chosen list, which is the one
thing that control must not do. `rowFields` already bounds the automatic list; past that,
someone asked by name. `compact` now reaches only the thumbnail size.

**`chipSlots` resolves the row as a whole, not a field at a time,** because the property that
matters on screen is that no two chips in one row share a colour — a repeat says "same kind of
thing" about two that are not. A field takes its declared slot when that slot is free and the
next free one otherwise. The table is arranged so the second branch is rare, which is what keeps
a field's colour stable across datasets; it exists for the two cases that cannot be arranged
away — a dataset publishing both names for one fact (`consensusNt`/`predictedNt`,
`hemilineage`/`itoleeHl`, which share a slot on purpose), and a list assembled in the inspector
out of fields the table never anticipated. Past the eighth chip it hands out nothing: the
neutral chip beats a hue that already means something three chips to the left.

**The colour is a scanning aid, never the identity** — eight hues do not clear the all-pairs
colourblind gate, and chips sit side by side in arbitrary combinations. Validated, not reasoned:
worst pair ΔE 1.6 deutan on the dark surface and 7.1 for normal vision, against a target of 8
and a hard floor of 15. Same finding and same doctrine as the socket colours. So every chip
keeps its text, and `somaSide`/`rootSide` — both `L`/`R` — additionally carry an inline key
(`soma L`), because two identically-lettered chips are a puzzle a tooltip should not have to
solve. `MAX_CHIPS` is 8, the size of the palette, so the automatic list can never want a colour
that does not exist. `trumanHl` is left out of it deliberately — the same fact as `itoleeHl`
under a second nomenclature, and two slots is too much to spend on that by default.

**Custom node bodies** live in `ui/nodes/nodeBodies.ts`, keyed by node type, exactly as
`ValuePreview` dispatches viewers. Registered in the UI and not on the `NodeDefinition`, because
a definition lives in `src/nodes` and must stay headless. A body renders in the card _and_ in the
overlay from the same prop bundle, so it cannot ship working in one and broken in the other, and
it sets the card width through `--node-width` rather than `width` so the run ring still follows.

## Profile: one neuron at a time

`out.profile`, the counterpart to Explore one level in — Explore answers "what is in this
dataset?", Profile answers "what is this cell?". Modelled on Codex's Cell Details page. It takes
a whole neuron collection and pages through it, so it works on an Explore selection or a
Connectivity result, not only a hand-picked body.

**Browse free, pin to commit — the whole design turns on this.** `page` is presentational, so
flipping through twenty-seven neurons costs nothing and invalidates nothing; `selection` is not,
and it is what the `Current` port emits. Had the page index fed `Current` directly, every press
of the pager would mark the downstream graph stale, and with auto-run on would fire a full pass
per page turn. Same live-widget/committed-param split that makes Explore feel like a browser.
`profile.test.ts` asserts it through the scheduler, because dropping the flag fails no type
check and the symptom — a graph going stale whenever anyone browses — reads as a scheduler bug.

**`minWeight` and `topN` are presentational too, and that is not an oversight.** Neither can
change a byte of what either port carries: the outputs are the pass-through and the pinned row.
They decide what the widget draws. The threshold is also not passed to the fetch, so raising it
never costs a round trip — one request at weight 1 serves every threshold above it.

**`cheap`, despite the widget fetching.** `evaluate` touches no network at all. The connectivity
and ROI requests are the widget's, issued per neuron _viewed_. Same reasoning as
`out.neuroglancer`.

**Three requests per neuron, and identity is free.** Type, classification, transmitter call and
synapse totals all come off the neuron's own row in the incoming table, which already carries
every column schema discovery found — no index download, no query. Only the two connectivity
fetches and the ROI breakdown go to the wire, and they are cached per body.

**`roiInfo` nests, so the region bars must filter.** A synapse in `LO(R)` is counted again in
its parent `OL(R)`; summing the raw blob reports roughly twice the neuron's synapses. Only
`Meta.primaryRois` names a set that tiles the volume, so `DatasetInfo` grew `primaryRois` and
`runDiscovery` now captures it — the Cypher already returned it and threw it away. Note the
`ordered` swap at the end of discovery is now unconditional: it carries the ROI list as well as
the statuses, and a dataset whose status sample came back empty would otherwise keep handing out
an info without it. When the list has not arrived the widget says the totals may double-count
rather than presenting them; `undefined` is not `[]`.

**Paging is debounced, not aborted, and the distinction is load-bearing.** Two profiles on the
same neuron share one in-flight request, so cancelling on unmount kills the fetch the other one
is still waiting for. Not fetching for `SETTLE_MS` has no such failure mode, and a neuron already
cached skips the wait entirely — so paging back through what you have seen stays instant.

**The card and the overlay show different 3D on purpose.** The card draws the cached coarse
silhouette (free, usually already fetched by Explore); the overlay mounts a live neuroglancer
frame, in a tile that is **2×2**. A grid column is ~190px, which is not a 3D viewer — it is
about the width of neuroglancer's own layer bar, so a one-cell tile showed the chrome and
nothing else. The `min-height` on that rule is the half that actually does the work: rows are
auto-sized, so spanning two of them beside tiles that are five lines of text tall resolves to
roughly one card's height, and the span alone would make the tile wider and no taller — which
looks like it worked. `profileViewer.test.tsx` asserts the declaration, since jsdom does no
layout. (`uiScale` is the other lever for the same complaint; the frame does not use it yet.) Each frame is a full WebGL application that starts fetching EM on mount and a canvas can
hold a dozen profile cards. The card carries an `Open 3D` control inside the tile, because a
difference the user cannot see is a bug. `NeuroglancerProfileFrame` wraps `NeuroglancerViewer`
rather than reimplementing it — the `#!+` merge is what keeps the camera across a page turn, and
it was established against the deployed viewer rather than reasoned about.

**A tile renders only when its data exists.** Datasets disagree about nearly everything, so a
tile that cannot say anything is absent rather than full of dashes, and nothing in the widget
names a column that must be present. `transmitterReading` matches by name against whatever
discovery found — and checks presence _before_ `Number()`, because `Number(null)` is 0 and a
missing probability would otherwise draw a confident zero-length bar. Same trap `numeric()`
exists for.

Two small general changes came out of this, both worth knowing about:

- **`ValuePreview` gained `onParamChange`.** The viewer-to-node write path was hardcoded to
  `selection`; the pager needs `page` as well. `onSelectionChange` stays as the narrow
  convenience for the three viewers that only ever write a selection.
- **`ColumnsParam` gained `optional`.** A decorative picker with nothing to offer is not an
  issue — Profile's `Tags` on a table whose schema is not yet known was raising a warning badge
  about a control nobody had touched, which is how a real issue further down the list stops
  being read.

## Dataset Summary, and the two ROI nodes

`out.datasetSummary` answers the question that comes before Explore's and Profile's: **what is
in this dataset at all?** Neuron counts, how they are classified, and — the part no other surface
here can show — how completely each region has been reconstructed. Codex's Stats page is the
reference; region completeness is the addition, and it is the most useful thing on the card,
because a connectivity result out of a region that is 39% traced means something quite different
from one out of a region that is 91%.

It ships with two ordinary query nodes rather than swallowing their data privately:
`neuron.roiCompleteness` → Table and `neuron.roiConnectivity` → Matrix + Table. Both take nothing
but a Dataset — they are the only query nodes here that ask about the **volume** rather than
about a neuron id list — and both flow into the Heatmap, the Bar Chart, Filter, Download and the
notebook exporter for free. The Summary's own region tiles read the same source methods, so the
card and the nodes cannot disagree.

### Where the numbers come from

`/api/cached/roicompleteness` and `/api/cached/roiconnectivity`, both precomputed on neuPrint's
side, which is why a whole connectome answers in kilobytes and why a card can afford to ask about
male-CNS at all. Measured across every family: completeness is 9 kB / 229 rows on hemibrain and
217 kB / 5,412 rows on male-CNS; connectivity is 211 kB / 63 regions and 681 kB / 111. Both are
cached through `loadCachedTable`, so a graph holding an ROI node and two Summary cards on one
dataset costs one request.

The categorical breakdowns come from the **neuron index** — the same whole-dataset table Explore
searches — rolled up locally by `nodes/lib/datasetStats.ts`. That is why the Summary loads it on
mount like Explore does, and why the shared hook below exists.

### Four things that were verified rather than assumed

Each produces a plausible wrong number rather than an error, which is why each has a test.

- **Omitting `?dataset=` returns HTTP 200 for a different connectome.** Not a 400 — neuPrint
  answers about whatever database the deployment defaults to (`optic-lobe` on Janelia), with a
  well-formed 40 kB body. Same class of failure as a query that forgets its base URL, and the
  same answer: `cached()` in `client.ts` takes the dataset as a required argument.

- **The completeness ROI list nests; the connectivity one does not.** hemibrain returns `AL(R)`
  and `AL-DA1(R)` as sibling completeness rows — 229 rows of which 63 tile the volume — so
  summing the column as published gives 20,988,880 presynaptic sites against a true 9,428,400 —
  a **2.2x** overcount, and only the filtered figure agrees with `Meta.totalPreCount`
  (9,496,606). Hence the
  `primary` column, set from `Meta.primaryRois` in the source, and `Primary regions only`
  defaulting to on. But `roiconnectivity`'s `roi_names` is **exactly** hemibrain's 63
  `primary_rois`, so that endpoint has already filtered and a matching param there would be a
  control that never did anything. The two look like a pair and are not; `roiSummary.test.ts`
  asserts the asymmetry so nobody tidies them into agreement.

- **`fetch_roi_completeness` and `fetch_roi_connectivity` are `Client` *methods*.**
  `neuprint.fetch_roi_completeness` does not exist — introspected against neuprint-python 0.6.3,
  the same class of trap as `navis.interfaces.neuprint`. Neither takes a dataset argument, which
  happens to satisfy the "one `Client` per dataset node, and every fetch names it" rule for free.
  `fetch_roi_connectivity` also answers *long* (`from_roi, to_roi, count, weight`), so the
  emitter is a rename rather than a reshape.

- **`roiconnectivity`'s `weight` is not additive, and nobody here knows what it is.** Hemibrain
  `AB(L)→BU(L)` reports `count: 13, weight: 3.11` — weight below count, so it is scaled or
  normalised. Both travel in the Links table because both are what the server said; the matrix
  defaults to `count`, which is unambiguous, and no legend claims anything about weight until
  this is settled against neuPrintExplorer. `MockSource` defines its own `weight` as a synapse
  sum and says so — the two are **not** comparable, which is safe only because nothing reads the
  column's meaning.

**mushroombody publishes neither summary**, returning 200 with zero rows and no pairs. That is a
dataset with no regions rather than a failure, and it is said apart from "not landed yet" — the
same distinction the Description card draws.

### The card

Profile's two rules unchanged: **a tile renders only when its data exists** (hemibrain has no
`superclass`, MANC no `flow`, and a dataset with no ROI summary draws no Synapses tile rather
than four zeros), and **looking is free** — every param but `Status` is presentational, and the
node returns nothing, so there is no provenance to disturb.

**Region connectivity is not a tile, and it was.** It shipped as an overlay-only heatmap behind an
`enabled` flag that kept male-CNS's 681 kB off the card — and the flag was the wrong answer to the
wrong question. A 63×63 matrix at the size a tile gets is a field of coloured squares with no
readable labels, and shrinking a picture until it is only texture summarises nothing.
`neuron.roiConnectivity` draws the same data at whatever size it is given, into the same Heatmap
the tile embedded, so the capability moved rather than went.

What that left behind is worth noting as a pattern: with one caller and one kind, `useRoiSummary`'s
`kind` argument and `enabled` flag were both dead, so it became `useRoiCompleteness` and says what
it does. The *source* method, its cache and the node are untouched. The test that remains asserts
the **fetch that no longer happens**, with the stub still offering the method — a card quietly
downloading most of a megabyte for something it does not draw is the regression worth catching,
and an absent tile is not evidence of an absent request.

**The caption names the population every time.** The index is `MATCH (n:Neuron)` with **no status
filter** (`cypher.ts`), so the counts are over every neuron the dataset publishes rather than the
Traced subset `Find Neurons` and `IDs from Label` both default to. That is not an inconsistency
to tidy away — those narrow a population somebody asked about, this describes a dataset — but a
dataset-wide count with no stated population is the number that ends up quoted in a paper.

### Rings, bars and columns

Three chart shapes, and which one a tile gets is a rule rather than a list of field names.

**A ring under five values, bars above it.** A ring is a *part-of-whole* claim and stops being
legible as the slices thin out; a ranked bar chart is a *comparison* and keeps working at fifty.
`flow` has three values and `side` four — those are wholes, and three bars waste the one thing a
reader wants from them. `class` has ten on male-CNS and two hundred on somebody's own table.
Codex splits its own panels the same way; `MAX_DONUT_SLICES` is the rule behind the split.

The ring is drawn with `stroke-dasharray` on one `<circle>` per slice rather than with arc paths,
because a slice covering the whole ring is then an ordinary full-length dash — an `A`-command path
whose start and end coincide degenerates and draws nothing. Labels sit beside the ring, never on
it: slice text has to shrink with the slice, so a 3% category is either illegible or leadered out,
where a legend row is the same width whatever the share. Colour is never the only identification,
the same rule the socket palette and the Explore chips follow.

**A colour per chart, cycling the categorical palette by position.** Every bar being one blue made
eight charts read as one chart in eight parts. A repeat *across tiles* is harmless — the palette's
all-pairs gate is about series sitting side by side within one chart, which two tiles never do —
so the slices of a ring take adjacent slots and the tiles take theirs by index.

**Region completeness is vertical columns on a fixed 0–100% axis**, which is the whole reason it
is not `Bars` rotated. Completeness is a fraction *of something*, so 90% has to look like nine
tenths of the plot; normalising against the best region would draw it full height whether it were
90% or 9%, and two datasets would be compared on two different scales with nothing saying so.

Two things about that chart were wrong in a browser while every test passed, and both are the
class of bug that produces a plausible picture:

- **A percentage height needs a definite ancestor height.** With `min-height` on the plot the
  columns fell back to their content size and 98% drew very nearly as tall as 57%. jsdom performs
  no layout and reports every element identically, so no test here could have caught it.
- **`flex: 1 1 0` alone spreads six regions across a full-width tile as six slivers.** Capping
  `.tile__column` and left-aligning the plot lets a short chart simply be narrower than its tile.

**The columns chart is three aligned bands — values, tracks, labels — not one flex box per bar.**
The first version stacked all three inside a per-column box, and the labels are vertical text of
very different lengths: `AL(R)` against `mVAC(T3)(R)`. A long name ate its own column's track and
lifted that bar's baseline above its neighbours', so two regions 1% apart drew a centimetre apart.
Three rows of equally-sized cells give every track the same two lines to start and end on, and the
label strip is a *fixed* height rather than a capped one — a name too long for it ellipses, which
is the cost of the alignment and the right way round.

That structure is also what lets a reference line be correct. `bottom: 42%` on the band is the
same 42% the bars are drawn to, where the gridlines this replaced sat in the outer plot — with the
value and label rows shortening the bars' own box, so the 50% rule landed nowhere near the middle
of a 50% bar. That is why those were removed rather than fixed in place; this one shares the box
by construction.

**The mean line takes `--text-primary`, not `--text-muted`.** It shipped muted, on the reasoning
that a reference should not compete with the bars — and `--text-muted` is `#898781` in *both*
themes, which clears the 3:1 non-text floor for body text and disappears as a 1px dash crossing a
field of saturated green. It did not compete; it vanished. The ink token is `#0b0b0b` on light and
`#ffffff` on dark, which is as far from the chart as this palette goes, and still achromatic —
that part was never the problem, since a coloured rule over a categorical chart reads as another
series. The dash is what keeps it a reference at full contrast, and the label carries
`--surface-2` behind it because it sits *on* the bars, where white-on-light-green is the one
pairing the palette cannot survive.

Pinned by reading the stylesheet, as the Profile 3D tile's rule is: vitest applies no CSS and
jsdom resolves no custom properties, so a declaration test is the only kind that catches a
chart-chrome colour going invisible. Nothing else did — it looked deliberate.

**The mean is weighted, and that is the whole of the number.** Total traced over total present,
not the average of the per-region fractions. Averaging gives a ten-synapse neuropil the same vote
as `ME(R)`, which holds a fifth of male-CNS's volume: measured there, the weighted postsynaptic
mean is **41.8%** against **38.2%** arithmetic. The weighted figure is the one that answers "what
fraction of this connectome's postsynaptic sites belong to a reconstructed neuron", and the one
that agrees with the Synapses tile above it. It is computed over every drawn region and never over
the page, or the line would compare each page against itself.

**How many columns fit is measured, not chosen.** The completeness tile is full width in the
overlay and a fraction of a 560px card, so a fixed page size suited neither — ten columns used
half the overlay and still paged seven times through hemibrain's 63. `useElementSize` on the plot
and a `MIN_COLUMN_PX` floor gives 53 columns in the overlay and 20 on the card, each dividing the
width it is given. The floor is set by the *value* label rather than the bar: `100%` in the 8.5px
mono face is about 24px, and a column narrower than its own number clips it. The bar would read
fine at half that.

Two things about that measurement, both of which broke it first:

- **The measured box wraps `Loadable`, never the other way round.** `useElementSize` observes
  once, on mount, and bails when the ref is empty — so a box rendered inside the loading branch is
  null exactly when the observer is set up, and is never seen again. The chart then keeps the
  fallback page size for the session, which reads as a chart that simply chose a small number
  rather than as a measurement that never happened.
- **The wrapper is measured, not the plot.** Measuring the element whose child count the
  measurement decides is a feedback loop.

**`Region order` is ranked or by name**, and the pair is the point: ranked answers "where can I
trust this?", which is a question about the shape of the list, while by-name answers "how complete
is the region I already care about?" — and on male-CNS's 144 paged regions that is the difference
between looking something up and hunting for it. The name sort is `localeCompare` with `numeric`,
so `ME_R_col_10` follows `ME_R_col_9`; male-CNS names thousands of regions that way and a plain
string sort produces an order that reads as a bug. The value sort breaks ties on the name for the
same reason every ranked list here does — otherwise equal regions swap places between renders.

**There are no gridlines**, and they were drawn and removed rather than never tried: the rules sat
in the plot while the bars scale inside their own tracks, which the value and label rows shorten,
so the 50% line landed nowhere near the middle of a 50% bar. Every column prints its percentage,
so the reference was redundant as well as wrong.

**The primary ROI list comes from the *listing*, not from discovery.** `superLevelROIs` in
`/api/dbmeta/datasets` is `Meta.primaryRois` — checked set-for-set on every dataset the server
offers, identical every time — so it is read when the listing lands rather than two round trips
later, and it is there even if the `Meta` query fails. Discovery still overwrites it, since `Meta`
is the documented source and this is the same answer arriving sooner.

Two things that were wrong until it did. **Re-listing un-learned it**: `listDatasets` re-fetches on
every call and the Sources panel does exactly that, and the merge overwrote `primaryRois` back to
undefined — the trap the `statuses` line beside it has been guarding against since it existed, now
guarded for both. And **the card reported the wrong regions**: the Dataset tile printed
`info.rois.length`, so male-CNS read `regions 5,619` an inch above a chart over 144 and a caption
saying "144 primary regions" — two numbers on one card both called regions, thirty-nine times
apart, with nothing saying which was which. It now reads `144 primary of 5,619`, and says one
number where every region tiles the volume, as MANC's 59 do.

**The completeness chart drops only what it knows to be nested**, and getting that wrong emptied
it completely. `primary === false` is a region inside another one; `null` is the source saying it
could not tell yet, and an absent column is nobody having asked. A single `!== true` test read all
three as "nested" — and because it applies per row, every row failed at once, so the chart did not
degrade, it vanished behind the word `None`. Same unknown-is-not-empty rule as `columnSchemaFor`
and `validateColumnParams`; the difference here is that the failure is total rather than partial,
which is what makes it read as a fact about the dataset.

For the same reason the tile never says a bare `None`. Three different things read as "no chart"
and only one is about the connectome — no regions published, nothing recorded for *this* measure
while the other one works, or no synapses anywhere — so it names which, and points at the other
measure when that is the answer.

**A null completeness is checked before the conversion, never after.** `Number(null)` is `0` and
`Number.isFinite(0)` is true, so testing the converted value drew a region with nothing recorded
as a confident 0% column. The same trap `numeric()` exists for, found by the test written for the
paragraph above rather than by reading the code.

**Paging replaced the `Other` residual**, and that is a change of claim rather than of layout. A
residual says "there are 206 more and you cannot see them"; a pager says "there are 206 more, here
they are". Nothing is hidden, so nothing has to be admitted — the heading carries `9–16 of 214`.
Bars are scaled against the *whole* ranked list rather than the page, or page two would redraw its
largest bar full width and read as matching page one's.

**The page index is component state, not a param.** Profile's pager writes one because it feeds a
`Current` port and has to survive a reload; nothing here feeds anything, so which slice of a chart
is on screen is not a fact about the document — and a param would have to be one *per column
name*, which is a schema the node cannot know at definition time.

**`Completeness` is presynaptic or postsynaptic, and there is no third option.** neuPrint
publishes `roipre`/`roipost` per region and nothing else; `Meta.roiInfo` adds only
`mito`/`dark`/`light`/`medium`, which are EM annotations rather than tracing, so a
connection-level completeness would need per-connection data nobody publishes. Postsynaptic is the
default because it is the figure that bounds what a connectivity query can see — a connection is
only found when the *receiving* neuron is reconstructed — and the two differ by fifty points on
hemibrain, 91% pre against 37% post. The control is on the tile rather than only in the inspector,
because a switch that moves the reading that far belongs where the reading is.

**`statsFor` is a `WeakMap` memo in `searchIndexFor`'s idiom**, and it is what makes a Summary
card nearly free once Explore has paid: eight columns counted over 165,122 rows, once per table
identity, with the cap applied on the way out so a "show more" control costs no recount. Note the
knock-on in the viewer — the status filter is `useMemo`'d, because a fresh filtered table per
render would defeat the memo entirely and re-count everything on each unrelated store tick.

**`nodes/lib/datasetStats.ts` is headless**, the sibling of `profileStats.ts` and for the same
reason: jsdom has no canvas, so anything left in the component is covered by nothing. Two rules in
it are worth knowing. Null and empty string are the **same** absence and are folded before
ranking, because neuPrint publishes both for one thing depending on the property. And absence is
counted *apart* from the ranked values by default — "unspecified" is not a class of neuron, and
letting it in puts it near the top of most male-CNS attributes where it crowds out something that
says anything. Codex charts it as a bucket; here `includeMissing` is opt-in.

### The shared index hook

`ui/useNeuronIndex.ts`, moved out of `ui/explore/` when the Summary became its second consumer.
The *download* was already shared — `loadCachedTable` keys on (source, dataset), shares an
in-flight promise and persists to IndexedDB, and `cacheGet` promotes a hit into a module-level map
that hands back **the same object**, which is also why `searchIndexFor`'s `WeakMap` hits across
widgets. What was not shared was everything above it, and each of the three was invisible until a
second consumer existed: each mount set `status: 'loading'` before awaiting a call that resolves
from memory, so a second card flashed a spinner over data it already had; each printed its own
"downloading index" note for one download; and a reload pressed on one left the other showing the
table it had just replaced.

**Nothing is aborted on unmount, and that is deliberate.** The obvious `AbortController` is
actively wrong once the state is shared — the first card's unmount would cancel the fetch the
second is still waiting for, which is the trap Profile's paging already documents. There is also
nothing to save: the result is cached, so a download completing after the last widget has gone is
paid for and kept, where one abandoned half-way starts from zero.

**The load starts from an effect, never from render.** `ensureLoaded` publishes synchronously on
several paths, and publishing is *other components'* `setState` — during render that is React's
"cannot update a component while rendering a different component", between sibling node cards with
no relationship to each other. Nothing is lost by waiting a tick: a second widget feels instant
because the entry is already `ready` when its first `getSnapshot` runs, not because of the timing.

`resetNeuronIndexState()` is the test seam; module-level state outlives a test file otherwise.

### Tiles are shared, not copied

`ui/viewers/Tiles.tsx` — `Tile`, `Loadable`, `Facts`, `Bars` — extracted from `ProfileViewer`
rather than duplicated, the same call `LegendKeys` records. The stylesheet block was renamed with
them, `.profile__tile` → `.tile`, because a prefix naming one of two consumers is a claim that
goes stale; same call, and the same reasoning, as `.labels-body` becoming `.list-body` when
`InputIdsBody` joined it. What stayed in `ProfileViewer` is what knows its subject — the chips,
the shape preview and the pager.

**Its `ValuePreview` branch sits above the `!value` guard, and that placement is the whole reason
the card renders.** Every other viewer has an output port, so after a run it has a value and the
guard is a "nothing yet" state it passes through once. This one has **no outputs**, so its value
is undefined forever — below the guard its branch is unreachable and the card shows
`No result yet — run the graph to see output.` permanently. That is what it did, with a green
suite: every jsdom test rendered `DatasetSummaryViewer` directly and so could not reach the
dispatch at all. Found by pointing a real browser at it; `datasetSummary.test.tsx` now drives
`ValuePreview` itself, and that case fails if the branch is moved back.

**No visual verification exists for the card**, on the standing of the WebGL viewers: jsdom does
no layout, so the tile grid's reflow and the bar geometry are not asserted. They were looked at
once by hand, against the mock connectome in a real browser — which is what turned up the guard
above, the `wide`/`span` collision on the connectivity tile (an element carrying both takes
whichever rule the stylesheet declares later, and it is the span), and `Top cell types` at
Codex's twenty pushing the region tiles off a 620px card.

## ROIs: the volume rather than the cells

`out.rois`, `Add ▸ Visualisation ▸ ROIs`. Explore answers "which neuron?", Profile "what is this
cell?", Dataset Summary "what is in here?" — all three about *cells*. This one is about the space
they sit in: a dataset's neuropil shells drawn together in a named anatomical plane, coloured by
how completely each is traced. It is the only surface here that can answer "where is `LO(R)`, and
how much of it can I trust", which is otherwise two lookups and a mental model of fly anatomy.

**A Dataset Summary, not a 3D View.** The obvious sibling is `out.viewer3d`, since both draw
meshes, and it is the wrong one: that node takes geometry *on a wire* and something upstream
fetched it. This takes a Dataset and fetches for itself, which is `out.datasetSummary`'s
arrangement exactly — no outputs at all, an entry in `SELF_DRAWING_NODE_TYPES`, and `cheap`
despite the widget downloading tens of megabytes, because `evaluate` confirms the input is a
dataset and returns nothing. What a viewer fetches for itself is not what the scheduler has to
reason about.

### Three planes and no camera, which is the decision everything rests on

x/y, x/z, y/z. There is no free rotation, and that is not a limitation worked around — it is what
makes the whole thing affordable.

With an arbitrary camera the geometry has to be **kept**, because any angle can be asked for at
any moment. With exactly three projections there are exactly three answers, so a region is
fetched once, flattened into all three, measured, and **discarded**. What survives is polyline:
measured at **42 kB for hemibrain's 63 regions and 95 kB for male-CNS's 139**, against 29–62 MB
of mesh. Roughly three orders of magnitude.

Three further consequences, each of which deleted code rather than adding it:

- **Rendering is free.** Drawing is one transform over cached points, so there is no re-projection
  per frame at any region count. An earlier 3D build needed a reduced trace grid while dragging
  and a rule about reusing the previous frame's explode solution; both went away.
- **The trace grid can be larger than an interactive budget allows.** It is paid once, so
  `TRACE_GRID` is 512 rather than 256 — measured over all three planes including the relaxation:
  63 regions 108ms, 144 regions 291ms. 768 buys a quarter more points for 60% more time and stops
  being visible.
- **Every view is reproducible.** "Frontal" is a claim anyone can check against the picture, where
  a camera that happens to be pointing that way is a pair of angles nobody can read off one.

### Outlines are traced from a raster, never swept from a centroid

The obvious outline is the maximum projected radius per angular bin, and it can only describe a
*star-shaped* region. Neuropils are not: the mushroom body lobes wrap the peduncle and the gnathal
ganglia are plainly concave, so a swept outline silently fills in its own notches and draws every
region larger than it is. `roiProjection.ts` rasterises the projected triangles and walks the
boundary instead; `raster.test.ts` asserts that a point in a C's hollow is *outside* the ring.

**`raster.ts` was extracted from `thumbnail.ts` rather than copied.** The barycentric fill is the
same arithmetic whether it is shading a neuron thumbnail or filling a neuropil, and two copies
would drift on exactly one thing — whether a pixel centred on an edge is inside — with the symptom
a one-pixel seam in one viewer and not the other.

**The tracer's stopping criterion is load-bearing and its failure is invisible.** Moore-neighbour
tracing with no Jacob criterion walks the boundary repeatedly: the first version returned 177
points for a 44-pixel perimeter. That *looks* like a correct outline — but an even number of
traversals doubles every ray crossing, so the ring reads as **inside-out** to point-in-polygon.
The concavity test reported the hollow solid and the solid parts hollow.

### The explode is collision relaxation, not a radial push

Sliding each region away from the centroid is the obvious rule and it does not work: scaling every
centre about one point is a **homothety** — a uniform scale of the arrangement. The shapes do not
scale with it, so once the frame refits, the only perceptible change is the regions getting
smaller. It reads as pulling the camera back.

So `relaxShifts` does what nat.ggplot's exploding-neuropils does: each region is a disc *in the
projected plane*, and overlapping pairs nudge apart until none overlap. Non-uniform by
construction, so the picture un-stacks rather than scaling. Solving it in the view plane is the
other half — separation is guaranteed in the projection being looked at, which a 3D push never
promises, since two regions far apart in depth can sit exactly on top of each other on screen.

**The constants were measured against how much of each region is left visible** — rasterise in
depth order, nearest wins, count what survives. Frontal goes 61% → 93% mean visible and its worst
tenth 7% → 82%; lateral, nearly unreadable at rest, 23% → 88%. Disc radius is the **70th
percentile** vertex distance, because a disc around the furthest vertex of an elongated neuropil
claims far more room than the shape occupies. The anchor pull is **0.05**: at 0.22 it gives back a
third of the visibility to save a tenth of the frame growth.

**The push is biased sideways, and 100% is 1.5x just-separated.** A screen is wider than it is
tall and so is a brain, so vertical room is the scarce kind: unbiased, the frontal arrangement
explodes into a *portrait* block and wastes two fifths of a landscape card. `LATERAL_BIAS` rotates
each push toward the horizontal - a bias, not a constraint, so a pair stacked exactly vertically
still separates vertically. 1.7 is measured on share of a 620x460 card covered: frontal 62% -> 97%,
lateral 62% -> 98%, dorsal 99% either way. Past it the arrangement over-corrects into a letterbox
and the fill falls again, so it is an optimum rather than "more is better". `EXPLODE_GAIN` then
scales the finished displacements, because the solver stops at *just* separated and that reads on
screen as regions that have only barely stopped touching.

**The frame is held at full explode for every slider value.** Refitting per frame is the other
half of why a radial explode read as shrinking — the arrangement grows, the frame chases it down,
and size is the only thing left changing. The cost is that at rest the regions are drawn at 71–81%
of the available scale on a half brain and 64–87% on a whole one.

**Homologous regions move as mirror images.** Left unconstrained the solve treats `ME(L)` and
`ME(R)` as two unrelated discs, so a bilaterally symmetric brain explodes lopsided — which reads
as a mistake, because the anatomy plainly is not. Each pass projects the shifts onto the
symmetric subspace: a pair's screen-x displacements are averaged to opposites, its screen-y to a
common value, and a midline structure is held on the midline. Enforced *inside* the loop, because
symmetrising a finished layout moves regions after the last collision check and can push them
back into each other.

Measured on a synthetic bilateral brain, worst pair mirror error against a shift scale of ~7,700:
frontal 11,283 → 0 with visibility 95% → 94%, dorsal 2,545 → 0 with visibility 79% → **81%**. The
free solve was putting pairs further out of step than the displacements themselves; the
constraint costs at most a point and dorsal gains two, because shrinking the search space lands
on a better arrangement rather than a worse one.

**It stands down where it would mean nothing, and both cases matter.** A half brain — hemibrain
is one hemisphere plus the midline — has no twin for most regions, so pinning a midline
structure's sideways travel would buy symmetry the dataset does not have while costing the solver
a degree of freedom it could spend separating something. And **lateral is excluded entirely**:
that plane projects *down* x, so the mirror axis is the depth axis, homologous regions land on
exactly the same point, and "mirrored" degenerates to "identical" — which would pin every twin
superimposed forever, the one thing the explode is there to fix in that view. That superposition
is also why lateral leans on the coincident-centre tie-break, and most of why the `hemisphere`
filter exists.

### Getting the meshes, and why the card asks first

Everything below was established by `scripts/probe-roimeshes.mjs` against the live server. Each
would have produced a plausible wrong result.

- **`/api/roimeshes/…` 404s on `HEAD` and 200s on `GET`.** The probe's first version asked with
  HEAD and reported every dataset as having no meshes, directly above the megabytes of OBJ its own
  GETs had printed.
- **Coordinates are dataset voxels**, like skeletons and unlike the precomputed meshes. Unscaled,
  the shells sit a whole factor from every neuron drawn beside them, with nothing failing because
  both sets are internally consistent.
- **The OBJ dialect differs by dataset.** hemibrain writes bare `f 1 2 3` with no normals;
  male-CNS, MANC and optic-lobe write `f 1//1 2//2 3//3`. A parser assuming the first reads normal
  indices as vertex indices on three datasets out of four — and the counts match, so it builds the
  right number of triangles between the wrong points.
- **Four of thirteen datasets publish none at all** (banc, fib19, mushroombody, wasp3), which is
  what `capabilities.roiMeshes` declares. Within male-CNS exactly five regions refuse, and every
  one is an `-unspecified` bucket — unassigned synapses, not a shape. So a refusal is counted, not
  raised, and the caption says `139 of 144`.

**It is 29 MB gzipped for hemibrain and 62 MB for male-CNS** — four to nine times Explore's
whole-dataset neuron index. So the card opens on an explicit `Load N regions` rather than fetching
on mount. What lands is the polyline above, cached, so the second open has no button and no wait:
`idle` means "not stored", never "never loaded".

**The precomputed buckets were investigated and do not generalise.** hemibrain publishes
`neuroglancer_multilod_draco` ROI meshes at 0.4 MB for every region at finest detail — 73× better.
male-CNS and MANC publish `neuroglancer_legacy_mesh`, single-resolution, ~128 MB. There is no
uniform win, so the OBJ endpoint is the route and hemibrain's bucket is a fast path if it is ever
worth the special case. Worth knowing that `/api/npexplorer/nglayers/…` answers **unauthenticated**
and names the ROI layer outright for MANC, male-CNS and optic-lobe.

**A byte budget is the wrong lever, which is counter-intuitive.** Fetching cheapest-first would
drop `ME(R)`, `LO(R)` and `LOP(R)`: the largest files are the largest *structures*, so a budget
silently deletes the map's dominant features.

**Meshes are decimated as they arrive, not after the batch** (`data/meshDecimate.ts`). Vertex
clustering rather than quadric error — deterministic, one linear pass, and what it preserves best
is the silhouette, which is all the tracer reads. `DEFAULT_DECIMATE_GRID` is 32 because surface
cells go as `π · grid²`, so 32 lands near 3,200 vertices; 64 was the first guess and is *finer*
than several regions' own vertex spacing, merging almost nothing.

### Colour, and the one place the palette rule does not apply

Completeness (pre or post) on a sequential ramp, `region`, `side`, or flat. The two sequential
modes get a labelled ramp over the map - reusing `.colorbar` from the network legend rather than
growing a second one - and the others get none, because three colours and one need no key.

**Presynaptic reads red and postsynaptic blue**, which is the one place this app runs two
sequential hues. They are otherwise the same picture over different numbers, so with a single hue
a glance cannot say which measure is on screen - and on hemibrain the two differ by more than
fifty points, which is exactly the gap somebody could take off the wrong one. It is not an
all-pairs case: a viewer shows one or the other, never both. `sequentialColor` gained a hue
argument rather than a sibling function, because a second copy of the mode flip is how a
dark-mode ramp comes to read as a negative.

`RED_RAMP` was already in the validated palette as the diverging scale's positive arm; what is new
is using the whole of it, so its sequential claim was checked rather than assumed - monotonic in
lightness, luminance 0.729 to 0.055 against blue's 0.743 to 0.038, minimum step 0.032 against
blue's 0.018, end contrasts matching blue's within a tenth of a stop.

**`region` gives each neuropil its own hue and is deliberately not a categorical encoding.**
`colors.ts` never cycles a ninth hue, because in a chart a repeated colour claims two series are
the same thing. Nothing is encoded here: there are 63 to 152 regions, no legend could list them,
and the hue means only "this shape is not that shape" - the job neuroglancer's segment colours do,
hashed for the same reason. It is keyed on the **homology key**, so `ME(L)` and `ME(R)` come out
identical: they are one structure seen twice, and different hues would say the opposite. Hue is
the hash times the golden angle rather than `hash % 360`, which leaves consecutively named regions
looking alike often enough to notice.

### The level above the primary regions

Some datasets publish an ROI hierarchy, and the group above a primary region is what lets a map
of 144 of them be read a system at a time. When one is available the control bar grows a
**Groups** dropdown of checkable items beside the colour selector; when it is not, there is no
dropdown at all.

**`Meta.roiHierarchy` is the source**, a nested `{name, children}` tree, and it arrives as a JSON
*string* — neuprint-python decodes it server-side with `apoc.convert.fromJsonMap`, which this does
not depend on, so it is parsed in `roiHierarchy.ts`. Worth recording that
`Client.fetch_roi_hierarchy` **does not exist**: it is `neuprint.fetch_roi_hierarchy`, a
module-level function. The same shape as the `navis.interfaces.neuprint` trap — the obvious
spelling is a well-bound name and an AttributeError.

**A super ROI is the nearest ancestor that is neither primary nor the root**, and both exclusions
earn their place. The root is the dataset itself, so admitting it yields one group containing
everything: a control that does nothing dressed as one that does. And a primary region's own
children are *sub*-primary — they nest inside it — so the walk stops rather than mapping them to a
group they are only indirectly in.

**A region with no group is never hidden by a group filter.** hemibrain lists `AL(L)` and `GNG`
directly under the root, so ungrouped is the common case rather than an oddity — and no box could
ever be ticked to bring such a region back.

**Empty means every group**, the `chips` idiom, which makes the first untick the interesting one:
it expands to the full list minus one rather than starting from nothing, or unticking a single
group would hide every other and read as the control being inverted. Unticking back down to the
full set returns to empty, so "everything" has one stored form rather than two.

The mock declares a hierarchy of its own (`MOCK_ROI_GROUPS`) rather than going without, so the
control is demonstrable with no token — and the groups are the anatomy those regions really belong
to, because a control demonstrated on nonsense teaches the wrong thing about what it is for.

### Volume is carried and is marked an estimate

neuprint-python's own docstring says these meshes are "intended for visualization only. (They are
not suitable for quantitative analysis.)" — and Coda decimates them further before measuring. The
number is still carried, because nothing else in the app can say anything at all about a region's
size, and the tile is captioned `≈ from display mesh`. An unlabelled `7.9 × 10⁶ µm³` on a card
reads as a measurement.

### Smaller things that would each be a quiet lie

- **The `ValuePreview` branch is above the `!value` guard.** No outputs means the value is
  `undefined` forever, so a branch below it is unreachable and the card reads "No result yet"
  permanently. `out.datasetSummary` shipped exactly that with a green suite, because every test
  rendered the viewer directly — so `rois.test.tsx` drives `ValuePreview` itself.
- **Every param is `advanced`**, `out.neuroglancer`'s call: the map draws its own control bar, so
  generic rows above it would be the same four controls twice, spending a fifth of a 460px card.
  They stay `presentational`, so the expanded view's rail still offers them.
- **An absent `primary` column reads as unknown, not as nested.** A source that says nothing has
  not said its regions sit inside others — the same unknown-is-not-empty rule as `columnSchemaFor`.
- **The outline cache's fingerprint carries the format version, the trace grid and the region list
  by name.** Once the meshes are released these polylines are the only copy, so nothing about a
  stored set reveals which tracer produced it. That is the thumbnail cache's lesson, which
  persisted *refusals* and silently outlived the byte ceiling that created them.
- **Regions are focusable and named** (`role="button"`, `aria-label`). Colour is never the only
  channel here, and it is also what lets `.roi__label` stay `pointer-events: none` so a name never
  blocks the shape under it.

**No visual verification exists**, on the standing of the WebGL viewers: jsdom does no layout, so
the grid areas, the outline geometry at real sizes and the label thinning have not been looked at
by anyone. Everything testable is tested headlessly, and the mock source generates synthetic
shells so the node works offline and on every bundled example.

## Run indicator

A stroked rounded rect traced round the node perimeter (`ui/nodes/NodeRunRing.tsx`), replacing
a 2px linear bar that showed the same number inside one card.

`pathLength="1"` on the rect makes `stroke-dasharray` a plain fraction, and the rect's
geometry is set in **CSS** (an SVG 2 geometry property) — together those mean the ring tracks
a node whose height changes with no measurement and no ResizeObserver.

**It is a sibling of `.coda-node`, not a child.** The ring is drawn 3–6px _outside_ the card,
and the card clips with `overflow: hidden`; rendering it inside would work only by accident
(handles escape that clip today solely because `.coda-node` is unpositioned, so their
containing block is React Flow's wrapper). As a sibling it is unambiguously outside the clip
chain. `runRing.placement.test.tsx` asserts that, because moving it back inside throws
nothing and fails no type check — the outline just quietly loses everything past the edge.

**It paints _behind_ the sockets, via `z-index: 0` and DOM order.** A right-hand socket
reaches 6.5px past the card edge (`right: -1px` plus React Flow's `translate(50%)` on an 11px
disc), so it genuinely intersects the ring. Passing behind the opaque discs keeps the outline
tight to the card; raising the z-index draws it straight through every socket.

**Size the ring explicitly; never `width: auto`.** `<svg>` is a _replaced_ element, so
`width: auto` takes its intrinsic size (300×150 with no viewBox) and drops `right`/`bottom` as
over-constrained — an `inset: -6px` shorthand drew a fixed 300×150 box hanging off the node's
corner, which read as a bounding box around the outgoing edges. Hence
`width: calc(100% + 2 * var(--ring-out))` with a matching negative `top`/`left`; percentages
resolve against React Flow's wrapper, which is the card's size. jsdom does no layout, so
`runRing.placement.test.tsx` asserts the _declaration_ instead — the only way this class of
bug is catchable here.

**The gold is per-mode and computed.** It sits on the _canvas_, and a bright gold that reads
at 10.2:1 on the dark canvas is 1.5:1 on the light one — under the 3:1 non-text floor, i.e.
invisible. Hence `--status-running-ring`: `#fab219` dark, `#a87400` light (3.4:1). No single
value clears 3:1 in both while still looking gold; the ones that do (`#9c6a00` and darker) are
muddier on dark than the blue they replaced.

Two channels, deliberately: **pulse** says running (a static ring cannot be told from a
stalled node), **length** says how far. Indeterminate work gets a short _travelling_ arc
rather than a pulsing full ring, because a complete outline reads as finished. Under
`prefers-reduced-motion` the animations go and the arc stays — motion is decoration here,
length is information.

A conic-gradient border is the obvious alternative and is wrong: it sweeps by angle about the
centre, so on a wide node the arc races along the short edges. Perimeter distance is what
reads as progress.

**The indicator is only worth anything because the sources report.** Every node used to call
`ctx.progress` exactly once, so a ring would have frozen at 10% for the whole fetch —
`Meshes` most of all. `GeometryRequest.onProgress` now carries a fraction from the source,
which is the only layer that knows how many bodies have landed.

Two traps in that plumbing, both hit:

- **Count completions, not dispatches.** An ordinal handed out when a task starts runs
  backwards with six workers in flight: skeleton progress went `0.6 → 0.4 → 0.8 → 0.2 → 1`.
  Increment in the callback, after the await.
- **Weight the phases.** Reading mesh manifests is a few hundred bytes per body; the fragments
  behind them are megabytes. `meshProgressFraction` gives manifests the first fifth, so the
  bar does not reach the halfway mark in the first second and then appear to hang.

## Sharing a workflow

The **⧉ icon in the toolbar**, or the palette's `Graph ▸ Share Workflow…`: a link that opens
this graph. Neuroglancer's model, which is what makes a neuroglancer view mailable with no server
anywhere — the state goes after `#!`, and a fragment is the one part of a URL a browser never
sends to anybody.

**Two destinations, and the ordering is the design.** _In the link_ packs the graph into the
fragment itself; _GitHub Gist_ uploads it and leaves a forty-character link. The packed form is
the default and is strictly better right up to the point where it stops fitting: it cannot rot,
cannot be deleted by its author, needs no account and works for a recipient who has never heard
of any of this.

The numbers are what settle it. Measured across the five bundled examples, **deflate + base64url
is 1,540–2,004 characters** against 4,282–4,786 for the same graph as literal JSON — 2.8×, and
the difference between a workflow that pastes anywhere and one that does not. The case that
genuinely needs the gist is an Explore select-all: 10,000 neuron ids pack to **~56,000**, which
mail and chat clients cut short.

### The grammar

`#!` and one payload, dispatched on what it starts with:

| payload                | means                                            |
| ---------------------- | ------------------------------------------------ |
| `{…}`                  | the graph as literal JSON, percent-decoded first |
| `c1.<base64url>`       | deflate-raw of the minified JSON, format 1       |
| `gh://<user>/<gistId>` | a GitHub Gist, optionally `@<revision>`          |
| `gs://<bucket>/<path>` | an object on Google Cloud Storage                |
| `https://…`            | any JSON over https                              |

Coda writes the second and third and reads all five. **The literal form is kept because a link
you can read before opening is worth 2.8×** — it is what lets the docs print one, what makes a
hand-edited link work, and what the AI assistant would emit. Decoding is attempted and its
failure _ignored_, so a payload that was never encoded is not refused for containing a stray `%`.

**`c1.` names the format, not the algorithm.** An unrecognised blob then fails with a sentence
rather than an inflate error, and changing compressor later is a `c2` rather than a guess about
what the bytes were. **`deflate-raw`, not `gzip`**: measured 24 characters shorter, which is
exactly the gzip container — a header, a CRC and a length, none of which a URL wants.

**An unknown scheme is named.** `Coda cannot open "ftp://" workflow links` — the fix for `http://`
is a URL change and the fix for `file://` is to send the file, and a shared "bad link" helps with
neither.

**Base64 is chunked.** `String.fromCharCode(...bytes)` is the one-liner and blows the call stack
well below the size an Explore selection reaches, with nothing in the failure naming the array
that did it.

**Both writer promises are caught in `through()`.** A corrupt payload fails on _both_ ends of the
transform: the readable side rejects and is turned into a sentence, and the writable side rejects
with the same thing a tick later with nobody listening — an unhandled `Z_BUF_ERROR` beside a
message that had already explained itself properly. Found because a passing test printed a stack.

### Reading a link, and the two questions

`store/graphStore` reads `location.hash` **synchronously in its initialiser**, only to ask
_whether_ there is a link, which is a regex. That answer withholds the start page, and it has to
be settled in the tick the store is created: a link noticed an effect later means the welcome
modal is already up over a workflow the recipient has not seen. `useShareLink` does the reading
and the fetching an effect later.

**The fragment is cleared once handled, including on a decline.** Left in place, a reload after
ten minutes of editing silently reverts to the shared graph, which is the worst thing this
feature could do. The link is not the store; the dialog regenerates it.

Two confirmations, for two different questions, asked in the order that lets the first be
answered without touching the network:

1. **Fetch from this host?** — only for a bare `https://`, whose destination the recipient cannot
   see. Shortening a link is exactly the act of hiding where it goes. `gh://` and `gs://` name a
   known host _in the link itself_ and do not ask.
2. **Replace what is on the canvas?** — only when there is something to replace. `loadGraph`
   resets the history and the autosave is the only copy of what is about to go. Same shape as the
   start page's card confirm, and `window.confirm` is avoided for the same reason.

A fresh tab following a gist link answers neither, which is the common case.

**What a shared graph runs is nothing, and that is a property rather than a promise.**
`loadGraph` schedules the _cheap_ pass, so anything `cheap` executes without the recipient
pressing anything — and `core.tableFromUrl`, the only node that fetches a URL written into the
document, is `expensive`. It is expensive for its own reason (invariant 6: its URL is a text
field, and `cheap` would fire a request per keystroke), but that reason is now smaller than the
one that depends on it, so `store/shareLoad.test.ts` pins it. The rest follows from what already
exists: `deserializeGraph` validates and drops, note and blurb markdown goes through an AST
parser that cannot emit raw HTML, and no credential is ever inside a graph.

### The gist half

`api.github.com` is **fully CORS-open**, verified rather than assumed: the `POST /gists`
preflight answers 204 with `Access-Control-Allow-Origin: *`, `Allow-Headers` including
`Authorization`, `Content-Type` and `X-GitHub-Api-Version`, and `Allow-Methods` including POST.
Reads carry ACAO too, and so do `gist.githubusercontent.com` raw URLs. So this works from the
static GitHub Pages build, where the Cypher API cannot reach — the same finding shape as the AI
providers.

**Anonymous gists do not exist.** GitHub removed them in March 2018 and an unauthenticated POST
is a 401. That is the whole reason a token is needed, and it is recorded so nobody re-checks it
hoping otherwise. **Reading needs no token**, which is what makes a link work for a recipient who
has never opened Connections.

**A third section in Connections**, beside Data sources and AI assistant. The top level there is
_what kind of connection_, and a GitHub token is a third kind — filing it under the sources would
make it a fourth connectome. `gist` scope and nothing else; the panel links to a token page with
that scope pre-selected, because the obvious thing to do when a page asks for a GitHub token is
to tick everything.

Four things that each produce a plausible wrong result:

- **`public` is rejected on a PATCH.** A gist's visibility is fixed at creation, so sending it
  anyway is a 422 on an otherwise perfectly good update. The secret checkbox is disabled once a
  gist exists for the same reason.
- **`truncated`.** The API stops inlining file content above 1 MB and hands back a `raw_url`.
  Coda's graphs are far under it and a graph carrying a large selection is not obviously so — and
  the failure mode is a _partial_ graph that parses, which is worse than one that does not.
- **Which file.** A gist can hold several and people add notes to them, so the one ending
  `.coda.json` wins; a single-file gist is taken as-is whatever it is called, so a link to
  somebody's hand-written `workflow.json` still opens.
- **One `GET /user` for concurrent askers.** The login cache is written when the answer _lands_,
  so two callers a tick apart both miss it. Not hypothetical: `StrictMode` invokes the dialog's
  effect twice, and that was observed live as two calls against a rate-limited API for one dialog
  opening. Same in-flight-promise idiom as `loadCachedTable`.

**`meta.gist` rides in the document**, which is what lets Share _update_ the link somebody
already has instead of littering a gist every time it is pressed. A gist id is public by
construction, so nothing private travels with it — and `owner` is what makes it safe: a graph you
were _sent_ names somebody else's gist, and PATCHing that is a 404 with nothing to explain it, so
Share offers Create instead. Note the chicken-and-egg that makes this work out on its own: the
uploaded JSON predates the id, so a recipient's copy carries no `meta.gist` and re-sharing
correctly creates their own.

It is committed with `autoRun: false` — bookkeeping about a link is not an edit, and a workflow
going stale because somebody copied its address would read as a scheduler bug. Same standing a
resize has.

### The advisories, and why this is a dialog

A menu item that copied a link would be smaller and would be wrong: what a shared workflow does
_not_ carry is not obvious, and the moment to say so is while the sender still has it in front of
them and can attach the file or mention the token. `ui/shareAdvisories.ts` is the rule, pure and
headless — `canExport.ts` in an advisory mood, and nothing here refuses a share, because unlike a
notebook on a connectome that does not exist outside the tab, a link is worth having in every one
of these cases.

- **An upload names the _file_**, never the content hash, because the filename is the only part
  of this anybody can act on. The rows are in IndexedDB by content address, exactly as a
  `.coda.json` has always been.
- **A real connectome names itself**, so the recipient is told they need their own token — and
  told that only Run needs it. A synthetic dataset earns no advisory at all.
- **A link over `LONG_LINK_CHARS` (8,000)** recommends the gist. Not a browser limit — Chrome
  carries about two megabytes and a fragment never reaches a server — but mail wraps, chat clients
  elide, and trackers linkify as far as they feel like.
- **A localhost origin** says so, because a link built on a dev server opens nowhere else.

**What does not travel**, and is not hidden: uploaded rows, both credentials, the panel and
layout preferences (per-user, deliberately never in the document), and the camera — `loadGraph`
bumps `fitRequest`, so a shared graph is framed by fit rather than by the sender's viewport,
which is right when the recipient's window is a different size.

### Small things the cleanup pass settled

- **`serializeGraph` gained `{ compact: true }`.** The codec was spelling the minify pass as
  `JSON.stringify(JSON.parse(serializeGraph(g)))` — three walks of the document and a throwaway
  copy of it, to undo indentation the same call had just added.
- **`deserializeGraph` validates `meta` now**, through a `validMeta` beside `validSize`. That
  block was passed through whole, which was harmless while it held a name and two timestamps
  nothing acted on. `meta.gist` names a gist `updateGist` will PATCH with the user's token, and a
  `.coda.json` is a file people mail each other.
- **`setGraphGist` does not go through `commit`.** `commit` runs `inferGraph`, refreshes every
  node's state and pushes a history entry unconditionally; no node can read `meta.gist`, so all
  of that was work for nothing on the largest graphs — and the new graph object it minted also
  re-ran the whole deflate behind the dialog. It sets and autosaves, the narrower path
  `afterSourceLearned` takes.
- **The gist filename comes from the caller**, through the same `slugify` `Download .coda.json`
  uses. Computing one user-facing name in two places is how the two come to disagree; they had
  already, over a length cap.
- **`copyText` lives in `ui/export.ts`**, shared with the neuroglancer link button. Its failure
  goes to the notice channel — the share dialog was writing it into `GistState`, which rendered a
  clipboard error in the gist result slot in *link* mode and, worse, overwrote `state: 'done'`,
  taking the freshly created `gh://` link off the screen when a copy failed.
- **`useDismissOnOutside` gained `outside`.** The share dialog had no Escape at all and the gate
  hand-rolled a sixth private listener. The gate passes `outside: false`, which is the reason the
  option exists: dismissing there discards a link somebody was sent, and on the replace prompt
  the other answer discards the canvas — a stray backdrop click is not an answer to either.

### What it costs, and why it is not lazy

**+22.9 kB raw / +7.3 kB gzipped on the main chunk**, measured against the same build with the
feature stashed out (930.75 → 953.63 kB). That is the codec, the resolver, the gist client, both
dialogs and the advisories.

**Splitting the dialog out was measured and declined.** `React.lazy` on `ShareDialog` yields a
6.72 kB chunk and takes only **1.78 kB gzipped** off main, because the half that cannot move is
the half that matters: `hasShareFragment` runs in the store's initialiser, the resolver and the
gate run on any page load carrying a link, and the advisories are read as the dialog opens. This
codebase's bar for a lazy boundary is the exporters at 17.6 kB gzipped and elkjs/three/sigma far
above that; under two kilobytes buys a `Suspense` boundary and a second code path for nothing.
Re-measure before adding to this — the number to beat is the one above, not the chunk size.

### Two CSS notes, both found in a browser

**Both panels set `height: auto`.** `.overlay__panel` is `height: 100%` because the panels that
came before these are scrolling bodies wanting every pixel; the share dialog is a link, a sentence
and a few asides, and at full height it rendered as a 640px card with four hundred of them empty
below the text — which reads as content that failed to load. `max-height` still caps it. Same for
`.share-gate__panel`. jsdom performs no layout, so this is exactly the class the suite cannot see.

**Everything else is `.sources`'**: header, section bar, notes, field rows and result lines are
reused outright rather than copied. They are the same kind of object — a modal about something
outside the document — and a second set of near-identical rules is how two dialogs drift on what
a note looks like.

### What was checked in a real browser

Headless Chrome over CDP against `pnpm dev`, because the codebase's standing lesson is that
jsdom reports one stubbed size for everything: the round trip (the `LC outputs` example → a
1,743-character link → a fresh tab restoring all seven nodes, the name, and an empty address bar,
with no console errors), both confirmations, the unknown-scheme refusal, gist create and gist
update with `api.github.com` stubbed in the page, and the two panel heights above. The link
length matched the headless measurement exactly.

## The workflow library

`Save ▸ Save in this browser` keeps a graph on the browser's own shelf; `store/library.ts` owns
it, the Open and Save menus show it, and the start page grows a _Your workflows_ rail when
anything is on it. It complements the download rather than replacing it — browser storage is
per-origin, per-profile, cleared with the site data and absent in a private window, so the file
is still the only durable artefact and the UI says so in both menus.

**IndexedDB, and its own database.** Not `localStorage`: the autosave already keeps a full copy
of the working graph in the ~5 MB origin budget, and an Explore select-all is ~110 kB of params
in one node, so a handful of saved graphs would hit quota — silently, since `saveAutosave`
swallows that by design. Not `data/cache.ts` either, despite the IndexedDB wrapper already being
there: that module is a _cache_, with expiry, fingerprint-as-miss and a `cacheClear`, and a graph
someone saved must never be evictable by anything that clears caches. A separate database also
keeps the two from racing on a version bump of the same `coda` one.

**Writes reject; reads resolve — and this is the one place the codebase's storage idiom
inverts.** Everywhere else a storage failure degrades silently, because a failure to _remember_ a
value is not a failure to compute it. That reasoning does not survive contact with a save: a save
that silently did not save is data loss, and reporting success would be worse than refusing. So
there is **no in-memory fallback** — where IndexedDB is missing there is nowhere durable, and
something that lives until the tab reloads is not a save — and `saveToLibrary` is the one action
that puts a storage error in front of the user.

The write path waits for the transaction's `complete`, not for its requests: a quota failure lets
the `put` succeed and _then_ aborts, so awaiting the request would report a save that was rolled
back.

**The stored graph is the string `serializeGraph` produces**, so a shelf entry is byte-identical
to what the download writes and the two paths cannot drift; reading goes back through
`deserializeGraph`, which is what gives a stored graph the same lenient loading and the same
warnings a file gets. Opening one routes through `loadGraph` like every other open, so the
history reset and the fit-on-load request are not reimplemented.

**An entry is a document keyed by its name, normalised.** Saving under a name already on the
shelf replaces that entry — after an inline confirm — and keeps its `createdAt`; renaming the
graph in the toolbar is what makes a second one. `normalizeName` folds case and repeated
whitespace, because "LC4 sweep" and "lc4 sweep" as two entries is a shelf nobody can keep tidy.
The alternative, appending a snapshot per save, fills the menu with copies that are
indistinguishable at a glance.

**The shelf is read lazily**, when a surface that shows it opens (`onOpen` on the two menus, an
effect on the start page) and after every write. Someone who never uses the feature never opens
the database. `libraryLoaded` is a separate flag from `library.length` on purpose: the rail hides
on empty and renders on loaded, and collapsing the two flashes a rail on every launch.

**`WorkflowSummary` carries `nodeTypes`**, which is why the start page can draw a tile per entry
without reading a megabyte of JSON per card. The list rather than a chosen type — deciding which
node stands for a graph is a UI question, and `startCards.tileNode` already answers it for the
examples. Same doctrine as everywhere else here: derived art, never per-item.

Two test-shaped notes. `store/library.test.ts` runs against **fake-indexeddb** (a devDependency),
because a persistence layer verified against an in-memory shim verifies the shim; each case gets
a fresh `IDBFactory` _and_ calls `resetLibrary()`, or every case after the first writes into a
dead database. And in `ui/panels/library.test.tsx`, never put a `fireEvent` inside a `waitFor` —
the click mutates the DOM, the observer re-invokes the callback, and the two chase each other
without ever yielding to the poll's own timeout. It hangs the run rather than failing it.

## Start page

The first thing anyone sees: a modal over the canvas with the alpha blurb, two rails of
starting points, the repo link and a "Don't show again" checkbox. `StartPage.tsx`,
`startCards.ts`, and the `.start*` block at the end of `editor.css`.

**A fresh visit now lands on an empty canvas.** `graphStore` used to auto-load `EXAMPLES[0]`
when there was no autosave. That works against the start page twice: the start page _is_ the
onboarding, and a graph the newcomer never asked for makes their first card click trip the
replace-confirm. Don't restore it.

**Closing is not dismissing.** Esc, ✕, Close and a backdrop click all just close;
only the checkbox writes `coda.startPage.v1`. Ticking it deliberately does _not_ close, so it
stays undoable in the same visit. `startPageOpen` is a plain boolean rather than a `seq` pulse
like `paletteRequest` — it is state the store owns, not a request a component has to catch, so
it needs no mount-seeded guard.

**No text, and no card, ever sits on raw image pixels.** The image is one layer;
`.start__scrim` covers it with theme tokens and goes fully opaque from the rails down. That is
what lets `public/start/backdrop.svg` be swapped for any photograph without re-checking a
contrast ratio — the numbers are the theme's, not the picture's. One image serves both modes
(a JPEG cannot adapt), so `--start-image-opacity` carries the difference: 0.55 dark, 0.32
light, because a picture with enough presence on the dark canvas turns the light panel muddy.

**Reference the backdrop through `import.meta.env.BASE_URL`.** `base` is `'./'` so the build
works from a subpath; a bare `/start/backdrop.svg` resolves to the domain root on GitHub Pages
and 404s — leaving a panel that looks fine locally and flat in production.

**Card art is derived, never per-card.** An example's tile glyph comes from the _terminal
viewer node_ of its own `build()`, a dataset's from the family table, both reusing the art the
app already draws (`nodeGlyph`, `datasetGlyph` — exported for this, not duplicated). Adding
the examples rail is what forced `out.network` and `out.viewer3d` into `NODE_GLYPHS`: without
them three of five examples drew the same generic bars. Every card also has an unused `image`
slot, so real screenshots drop in later without the layout moving. Same rule as
`NodeThumbnail`: per-item artwork means the next item ships blank.

**The replace-confirm is inline, on the card.** Loading resets the undo history, so a card
asks before overwriting a graph that has nodes. Not `window.confirm` — jsdom does not
implement it, and browser chrome in front of a page explaining the app reads as an error.

**Tests that mount the real `App` must close it first.** It renders over everything, which is
its job; `App.smoke.test.tsx` and `explore.test.tsx` call `closeStartPage()` in `beforeEach`
and one test opens it deliberately. A new App-mounting test that starts failing on
`getByText('Coda')` or `findByRole('dialog')` is hitting exactly this.

**The version comes from `package.json` through a vite `define`** (`__APP_VERSION__`), not a
JSON import, which would land the whole manifest in the bundle. An alpha that cannot say which
alpha it is makes every bug report ambiguous — so bump `package.json` when the build changes
meaningfully.
