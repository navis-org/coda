# Gotchas found the hard way — the reasoning behind each

The rule sentences live in `CLAUDE.md`. This is the incident behind each, moved
verbatim.

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
  its schema. `Paths → Network Viewer` (network _and_ layout) is the first wiring that hits it by
  design; Explore Dataset's `Hits` and `Selected` arriving at one Join is the other way in.

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

- **A column picker on its own default resolved to nothing until the schema arrived**, so a
  graph failed on its first Run of a session and worked on its second. `resolveColumns` had this
  guard and `resolveColumn` did not.

  Rule 3 is "the first compatible column" — an answer computed *from a list*. A port carrying no
  schema has an empty list, so a picker still holding the value its definition declared resolved
  to `undefined` before the schema landed and to the right column afterwards. That is the
  runs-twice-answers-differently signature again, and it lands in the provenance key.

  **The asymmetry is what hides it:** rule 2 already carries a value *differing* from the default
  through untouched, so this only ever bites a picker nobody has touched — which is the common
  case and the one nothing tests. Reported on `Table from URL → Combine Columns → Update root
  IDs`, the chain that node's own guide describes: `Table from URL` keeps its schema per URL in a
  session-scoped map, so a fresh session publishes none, and `Update root IDs` refused with "Pick
  an ID column and a supervoxel ID column" over two pickers the card was drawing as empty.

  The guard can only ever *add* an answer, never change one: it fires exactly when `available` is
  empty, where `available[0]` was already `undefined`.

  **An unset required picker now means its declared default**, which is the other half and is
  what keeps the two answers the same. A required picker has no "none", so an empty value is
  *unset* rather than a choice — and unset is what `defaultParams` fills with the default at
  creation. Without it, a default naming a real column still resolves to that column once the
  schema arrives and to nothing before, which is the same disagreement one paragraph up.

  **Only for a required picker.** On an `optional` one, empty is a *decision*: `out.scatter`'s
  `idColumn: ''` means "identify points by row index rather than by neuron id", against a
  declared default of `neuronId`. Reading that as unset hands the column back and quietly undoes
  it — a lasso that selects different rows. Its own test caught this within a minute of the
  change, which is the argument for it existing.

  Inert wherever the default is `''`, which is most pickers: `out.barChart`'s `Category` still
  means "decide for me".

  **And the widget said so out loud, which was the follow-up report.** With the resolver fixed
  the node ran, and the card still drew `ID column: neuronId (missing)` above `Supervoxel ID
  column: no column` — two false claims about a configuration that was correct, both pointing at
  the user. `columnSchemaFor` exists to separate *unknown* from *empty*, and both widgets asked
  only "is this name in the available list", which is `false` for a port carrying no list at all.

  Three states now, matching the resolver's: **unknown** offers the resolved value plainly, with
  the reason in a `title`; **known and lacking it** keeps `(missing)`, which is true there and is
  the drift the label exists for; **known and empty** keeps `no columns`. The `(missing)` half was
  the visible symptom, but the *disabled* half was worse — with nothing stored the option list
  came out empty, `SelectField` took its no-options branch, and the select rendered disabled
  behind a placeholder, so the one thing worth knowing was the one thing not shown.

  The plural had it too: `resolveColumns` keeps a stored list untouched while the schema is
  unknown, so labelling every chip `(missing)` contradicted the resolver an inch away. Its
  placeholder chip also now stands down when anything *is* selected — `cell_type × hemibrain_type
  × not run yet` reads as a warning about the two beside it.

  **`columnsKnown` names the question**, which `resolveColumn`, `resolveColumns`,
  `validateColumnParams` and both column widgets all ask. `columnSchemaFor(...) !== undefined`
  written at five sites is a rule nobody can grep for.

  **The widget is the reason nobody had stored a value.** A *required* picker renders
  `ctx.column(id)` — the resolver's answer — so a fallback is drawn exactly as a choice is. The
  reported graph carried `supervoxelColumn: ""` because the card had been showing `supervoxel_id`
  the whole time; it was the table's first column and the fallback had found it. That is "a
  default was never a decision" from the other side, and it is why `Update root IDs` now declares
  `supervoxel_id` rather than `''`: an empty default there meant *the table's first column*,
  which was right on FlyWire's published annotations by luck and is a guess with nothing behind
  it anywhere else.

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

- **`pivotTable` checks shape before it allocates**, and that is the backstop rather than the
  fix — the two entries above are the fix. `PIVOT_COLUMNS_WARN` / `PIVOT_CELLS_WARN` and the
  `MAX_*` floors beyond them are checked against the label cardinalities, because by the time an
  array exists the damage is done. The thresholds now *warn* — a 6,000-column connectivity
  matrix over an optic lobe is a real thing to want, and the old ceilings refused it in the same
  breath as they caught a misconfigured picker — and only the floors, sized from
  `CRASH_FLOOR_BYTES`, still refuse. See [limits.md](limits.md). It also allocates one accumulator per aggregation rather than all five, so `sum` costs
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

- **A buffer handed to `callPython` is detached the moment the call is posted**, so anything
  read *about* it — its length above all — has to be read before the `await`, not after. This is
  the second half of the transfer trap, and it is the half that fails loudly rather than
  silently: `warpPoints` gathers a fresh point buffer, transfers it, and then checked the
  returned count against `points.length` — which by then is 0, on a buffer the worker owns. So
  every Transform Neurons and Mirror Neurons run on a non-empty geometry died with `Warp
  returned 642 points for 0`, a message naming the two numbers and neither cause. The check is
  worth keeping — a length change would scatter every coordinate after the discrepancy onto the
  wrong point, i.e. neurons that all still draw — so the fix is one `const expected =
  points.length` above the call, not a weaker guard.

  Nothing in the suite could see it. `xform.test.ts` and `mirror.test.ts` both `vi.mock` the
  whole of `pyodide/warp`, and jsdom has no `Worker` to detach anything, so the wrapper's own
  arithmetic never ran against a real transfer. `warp.test.ts` is the layer that does: it mocks
  `callPython` and detaches the argument with `structuredClone(buf, { transfer: [buf] })`,
  which is the one line that makes the bug reproducible on the main thread.

- **`@type` is optional on a precomputed volume, and a graphene manifest is not all shards.**
  Two ways a mesh source resolves to somewhere with no meshes in it, both of which surface as
  neurons that have none.

  The first: `openMeshSource` and `probe.ts` both did `switch (info['@type'])` with `undefined`
  falling through to "legacy mesh directory". That is right for a mesh directory and wrong for
  every flat segmentation published before the field was conventional.
  `gs://flywire_v141_m783/info` declares `"type": "segmentation"`, eight `scales`,
  `"mesh": "mesh_mip_1_err_40"` and `"skeletons": "skeletons_mip_1"` — and no `@type`. Read as a
  mesh directory it opened as `legacy` **at the bucket root**, where no manifest exists. Every
  request 404d, and because a missing mesh is an ordinary answer (`readLegacyMesh` returns
  `undefined` for a segment nobody meshed) it came back as an empty result rather than an error.
  Two multi-resolution mesh pyramids and a skeleton set sat behind that, on a datastack whose
  Skeletons node had been declining for the whole of its life. `isVolumeInfo` is now the one
  predicate both readers ask, and it keys on the volume markers — `scales`, or a named
  `mesh`/`skeletons` — because a mesh or skeleton directory's own `info` carries none of the
  three. The split that goes with it: `openMeshSource` decides what a URL *is* and stays strict,
  `openMeshDir` opens a directory somebody already named and forgives exactly a 404 (a legacy
  directory usually publishes no `info` — banc's `neuron_meshes/meshes` is one). Only a 404: a
  CORS blip read as "legacy" is a directory whose every fetch then 404s per neuron.

  The second: a verified graphene manifest is not homogeneous. It mixes frozen fragments, named
  `~<layer>/<shard>-0.shard:<offset>:<length>` and read out of shard files under the mesh
  directory, with plain objects covering the parts of the neuron somebody has edited since —
  which live under `mesh_metadata.unsharded_mesh_dir`. One BANC neuron's manifest was **40
  sharded and 21 not**. Read from the mesh root the unsharded ones 404 individually, and
  `mapWithConcurrency` turns each into a dropped fragment rather than a failure — which is the
  right rule for one bad supervoxel out of 492, and here means the neuron arrives looking whole,
  minus every piece anyone has touched, under a green node. FlyWire's public segmentation is
  frozen and declares no such directory, so the datastack the mesh path was built against never
  exercised it. `fragmentUrl` matches on `.shard:` rather than on the `~<layer>/` prefix, because
  the prefix is part of the path *to* the shard file and the byte range is what makes a name a
  shard read.

- **Module init order.** `graphStore.ts` imports `../nodes` for its side effect, because it
  resolves node types the moment it loads the autosaved graph. Without that import,
  ordering in `main.tsx` becomes load-bearing and a bad order silently drops every node.
- **Whole-string patterns are anchored, in one place.** `anchoredPattern` in `data/terms.ts`
  wraps a user pattern in `^(?:…)$` to match Neo4j's `=~` semantics, so `LC.*` matches `LC4`
  but **not** `LPLC1`. Don't "fix" this — the real neuPrint source behaves the same way
  because Neo4j does. Everything that builds a whole-string match goes through that one
  function: `compileRegex` for a request pattern, `toTerm` lowering a **matches** filter row
  for a local source, and `rowClause` compiling the same row to Cypher. The `(?:…)` is
  load-bearing on its own — without it a user pattern carrying a top-level `|` has its
  alternation spliced into the surrounding one and quietly matches a superset.
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

- **CAVE's row cap is a per-deployment number, and a reference table has no root id.** Two
  failures on the same table, and each read as a fact about the data.

  The first: `refuseIfCapped` compared row counts against `CAVE_MAX_ROWS = 500_000` and did it
  as `rows >= CAVE_MAX_ROWS`. That constant is really `QUERY_LIMIT_SIZE`, the materialization
  engine's own config — default 200,000, set per deployment. Measured the same day with the
  same request shape: `prod.flywire-daf.com` truncated `hierarchical_neuron_annotations` at
  exactly 500,000 with `warning: 201 - "Limited query to 500000 rows`, while `cave.fanc-fly.com`
  answered all **1,994,371** rows of BANC's `codex_annotations` with no warning at all. So a
  complete answer was refused for being *larger* than a cap that server does not apply, and the
  refusal said CAVE had truncated it. Even spelled `===` — which is how `limits.md` described
  it — it waves through a genuinely truncated read on any deployment configured below 500,000.
  The tell has to come from the server: `countTable` posts the read's filters under
  `?count=true`, `queryTableCounted` runs the two concurrently so the check costs no wall clock,
  and `refuseIfCapped` refuses only when fewer rows arrived than the count. Note the recognition
  problem — the same query in `caveclient` returns two million rows and says nothing, which
  reads as a permissions or version difference and is neither.

  The second: `codex_annotations` is a `cell_type_reference` into `cell_representative_point`,
  and a reference table carries `target_id` and no root id anywhere in it. Asking for one is a
  **500** — `pt_root_id not in model or models for codex_annotations` — because `select_columns`
  is validated against the table's own model. The join endpoint is the answer, and it takes
  `select_column_map` and only that; naming one side drops the other side's columns rather than
  defaulting them, `suffix_map` leaves an uncontested name bare (`pt_root_id`, not
  `pt_root_id_ref`), and `count=true` on it answers *rows* rather than a count, so the count has
  to go to the base table. `caveclient` calls the same thing `merge_reference`.
