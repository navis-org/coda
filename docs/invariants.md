# Invariants — the reasoning behind each

The rule sentences live in `CLAUDE.md`. This is what each one cost to learn, moved
verbatim. Read the entry before arguing with the rule.

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
   MaleCNS workflow, a pipeline that ran to completion, and an Explore Dataset widget beside it saying
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
   converted an id to a `number` and were found together after one was reported: Explore Dataset's
   `neuronIdAt` (`Number(cell)`, so an eighteen-digit root id went into the `selection` param as
   `…857200`), `PartnerRow.neuronId` in `profileStats` (`toNumber`, and then
   `a.neuronId - b.neuronId` as a tie-break, which reports two adjacent wide ids as *equal*), and
   `NeuroglancerProfileFrame`'s `neuronId: number`, which becomes a neuroglancer segment.

   The Explore Dataset one is the instructive symptom, because it is precise and points nowhere near the
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
   addresses *by name* — `out.profile` validates on it, Connectivity Graph, Skeletons, Meshes and
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
