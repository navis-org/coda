# Testing layers

Which test file covers what — the index to consult before writing a new test.

Shared helpers live in `src/test/`, and are the thing to reach for before writing a local copy:
`graph.ts` (`node` — a node carrying its definition's default params, once written out byte for
byte in forty-five files; `findAndFilter` — the dataset → Find Neurons → Filter graph the recipe
suites cut from), `scheduler.ts` (`mockScheduler` — a Scheduler refusing every source but
the one it is given, once in nineteen), `findNeurons.ts` (`searchFor`), `arrange.ts`
(`arrangeHeadless` — the canvas's arrange run headless, with what it draws and every overlapping
pair), `importGraph.ts` (`reach` — the one transitive import walk, which two boundary tests had
written twice and let drift), `jsdomStubs.ts`, `storeReset.ts` and `caveStubs.ts`.

Dead code is checked in CI by `pnpm knip:check` (`scripts/knip-check.mjs`): knip's findings,
one line each and without line numbers, compared with the committed `knip-baseline.txt`. The
baseline holds what is kept on purpose — a symbol reached through a dynamically imported
module, which knip cannot follow, or an alias a suite depends on. A new finding fails until the
symbol is used, deleted or accepted with `pnpm knip:update`; a fixed one fails until the
baseline is refreshed. `knip.jsonc` sets `ignoreExportsUsedInFile`, so an export a module also
uses itself is its vocabulary rather than dead code.

## Testing layers

One row per file, by area and then by path; paths are relative to `src/` (the two `vite/` files
sit at the repo root). A row is the file's scope — what to search for when deciding whether a new
test belongs there — not its assertions: those are the file's `describe`/`it` names and its
header comment, which is where the reason for each case is written. Three conventions the rows
lean on:

- **A node is usually two files and sometimes three.** The arithmetic and the schema/value
  agreement (invariant 3) are in an ops file under `nodes/lib/`; the node's contract — ports,
  params, what reaches the key, `validate` and the refusals — is in a file beside its category
  (`nodes/<category>/` or `packs/<pack>/`); a card with a body of its own adds `ui/nodes/*Body`.
- **`live.test.ts` talks to a real server and is skipped unless its environment variable is
  set** — the row names it. Nothing that writes may point anywhere but a declared scratch copy.
- **jsdom performs no layout and has no WebGL, and vitest has no Pyodide.** Geometry, pixels and
  agreement with a Python reference are browser or Python probes (`pnpm probe:*`, named in the row
  where one exists); a Python-backed op is tested here around a mocked engine.

### Core, store and boundaries

| File                            | Covers                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `core/cachePolicy.test.ts`      | cache lifetimes: expiry strictly past the lifetime, a hand-written lifetime kept, preset labels      |
| `core/clipboard.test.ts`        | the clipboard fragment: what is copied, which text is refused as a graph (so a paste falls through), the merge and placement |
| `core/columnParams.test.ts`     | what a column picker may complain about: unknown vs empty schema, `optional`, an unseen plural list, a default resolving either side |
| `core/compactIds.test.ts`       | the compact spelling of long id lists in a document: exact round trip, refusals, and the key's digest |
| `core/dashboard.test.ts`        | the dashboard model: one cell per node, spans, mutators by identity, save/load, and the view flag written only when true |
| `core/graph.test.ts`            | topo sort, cycles (incl. two wires between one pair), serialisation, lenient loading, and `absentMeans` on load |
| `core/hash.test.ts`             | `stableStringify` for cache keys: a typed array digested over its bytes                              |
| `core/lruMap.test.ts`           | `LruMap`: eviction order, what counts as a use, `makeRoom`                                           |
| `core/markdown.test.ts`         | the markdown subset against real published blurbs, and what a hostile one cannot do                  |
| `core/missing.test.ts`          | the `core.missing` placeholder: wires kept, ports from the file's edges, written back as itself, never run or listed |
| `core/packs.test.ts`            | what a switched-off pack leaves offered: listings narrowed, a pack the open workflow uses kept, `packsHiding` |
| `core/ports.test.ts`            | variadic ports: expansion, resolution modes, arity pruning edges, `formerIds` rewriting stored handles, auto-wire per group |
| `core/recipes.test.ts`          | recipes: a slot per outside node, file round trip, renamed/gone ports, all-or-nothing attach, the wire-drop sockets |
| `core/reference.test.ts`        | reference edges: the round trip sorting, identity without a schema, evaluate not waiting, real cycles unchanged |
| `core/registry.test.ts`         | what `registerNode`/`registerPack` refuse: the type-id grammar, reserved ids, changes after freezing, ambiguous `formerTypes` |
| `core/scheduler.test.ts`        | the Scheduler: hybrid eval, caching, invalidation, `ctx.publish`/`ctx.warn`, run progress (via `onStateChange`), loops, in-flight evaluations |
| `core/slice.test.ts`            | `sliced`, the shared yielding loop: adaptive clock stride, progress, cancel — pinned here rather than in a calling node |
| `core/sockets.test.ts`          | `PortDef.kinds`: declared sets, overlap, tiers, refused spellings, and the registry sweep over every `any` port |
| `core/splice.test.ts`           | dropping a node on a wire: the downstream check, isolation, one link left on the port                |
| `core/stats.test.ts`            | type-7 quantiles and the CSR grouping helper                                                         |
| `core/valueBytes.test.ts`       | the memory estimate per column shape (`pnpm probe:memory`) and the ledger charging shared buffers once |
| `core/values.test.ts`           | a geometry value's footer line: units, voxels vs unknown, the skeleton route                         |
| `core/withDefaults.test.ts`     | a param nothing stored reads as its declared default, and keys/evaluates exactly as one carrying it  |
| `store/assistant.test.ts`       | an assistant plan reaching the document: one undo step, a refusal changing nothing (plan rules are `assistant/assistant.test.ts`) |
| `store/autosave.test.ts`        | the autosave across tabs: slots, adoption, a duplicated tab; freshness at boot, asserted on the store since React Flow's mount hid it |
| `store/autowire.test.ts`        | a new node's Dataset socket arriving fed, and every case where it must not                           |
| `store/companion.test.ts`       | a dataset node bringing its Description card as one undo step, and which families opt out            |
| `store/documents.test.ts`       | several workflows in one tab: minting vs reusing, what a switch restores, separate caches, the reload seam, duplicates |
| `store/fitOnLoad.test.ts`       | opening a graph requests a fit, and an empty one leaves nothing pending                              |
| `store/groups.test.ts`          | group frames at the store and in the file: exclusivity, deletion, colours, one-step drag, stale promoted params |
| `store/hints.test.ts`           | writing a hint at the store: one undo step, no-op lists, the loader's repair rules                   |
| `store/inference.test.ts`       | inference against a source that has not learned its listing yet, and the re-infer signal             |
| `store/library.test.ts`         | the browser shelf against real IndexedDB: name as identity, a save with nowhere to go rejecting      |
| `store/links.test.ts`           | breaking and re-routing links: one undo step, the id kept, a refused rewire                          |
| `store/lock.test.ts`            | the canvas lock at the store: every action it refuses and every one it allows                        |
| `store/memory.test.ts`          | per-workflow memory: a duplicate's adopted results charged once, background and active drops         |
| `store/recipeActions.test.ts`   | the store's recipe actions: attach targets, refusals in `notice`, one undo step, import under a free name |
| `store/recipes.test.ts`         | the recipe shelf against real IndexedDB: slots through a save, text byte for byte, rename, rejecting saves |
| `store/session.test.ts`         | the open-workflow set in IndexedDB: order, per-tab sessions, bounds, a missing IndexedDB as an empty session |
| `store/setParams.test.ts`       | `setParams`: several params in one commit and one undo                                               |
| `store/shareLoad.test.ts`       | a share link at store creation: no welcome modal over it, and nothing run on opening                 |
| `store/shelf.test.ts`           | what the two shelves share: `freeName`, `newestFirst`                                                |
| `store/splice.test.ts`          | splice-onto-wire: move and rewire as one undo, a misfit node still moved                             |
| `store/unrecordedParam.test.ts` | an `unrecorded` param written with no undo step                                                      |
| `test/importGraph.test.ts`      | invariant 1 transitively: headless dirs (read off `eslint.config.js`) and every Web Worker reach no UI/store; `nodes/lib` not `src/style` |

### Layout

| File                         | Covers                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `layout/align.test.ts`       | align and distribute: sizes used, the selection box as anchor, gap evening, no move for a card in place |
| `layout/collapse.test.ts`    | folding a group: the box, merged wires split by port, the ELK sockets, promoted controls and their rows |
| `layout/companions.test.ts`  | Description companions and chain captions laid out with their host: pairing rules, the grown box, real ELK, load/paste |
| `layout/groupBounds.test.ts` | a frame's drawn box: padding, measured over declared size, a frame with no members                   |
| `layout/layout.test.ts`      | the ELK mapping and placement, port convention and option keys against real ELK, a laid-out network  |
| `layout/pack.test.ts`        | the column packer post-pass: fills slack, refuses bad moves, leaves a graph it cannot improve exactly as ELK left it |
| `layout/placeGuards.test.ts` | no built graph (wizard, demos, starters, assistant shapes) drawing a card over another, incl. after the starters' arrange |
| `layout/routing.test.ts`     | edge routes: bends past cards, pinned sockets, partial measurements declined, what stales a route    |

### Data layer (`src/data`)

| File                                           | Covers                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `data/ai/ai.test.ts`                           | the four assistant providers behind one interface: bad-key statuses, schema in prompt, `num_ctx`, per-provider settings |
| `data/annotations/annotations.test.ts`         | annotation sources (FlyTable, Sheets, CAVE reference tables); its BANC stub answers by request *body*, hence not `test/caveStubs.ts` |
| `data/annotations/labels.test.ts`              | `morphologyAttributes` rows against the published morphology schema (invariant 3), for CAVE and Custom Dataset |
| `data/annotations/live.test.ts`                | live FlyTable (skipped without `SEATABLE_TOKEN`) and Google Sheets' CORS header (`GOOGLE_SHEET_LIVE`) |
| `data/annotations/targets/clio.test.ts`        | the Clio write target against a stub — the only place Clio writes are exercised; ids exact, tokens, DVID-typed fields |
| `data/annotations/targets/csvFile.test.ts`     | the CSV write target over an in-memory file handle: exact ids, format kept on write, conflicts, appends, per-file queue |
| `data/annotations/targets/fieldValues.test.ts` | a cell's text and value round-trip for every annotation field kind                                   |
| `data/annotations/targets/live.test.ts`        | SeaTable writes to FlyTable's scratch `main_test.info_test` only; skipped unless `SEATABLE_WRITE_TEST` plus the token |
| `data/annotations/targets/seaTable.test.ts`    | the SeaTable target against a stubbed deployment: editable columns, the SQL (always a `LIMIT`), writes, tokens, dates |
| `data/annotations/targets/sideEffects.test.ts` | what a write writes besides the edited cell (derived instance field), and undo of an unchecked change |
| `data/annotations/targets/targets.test.ts`     | the rules every annotation target shares, via the in-memory target: absence, refusals, conflicts, batching, typed text |
| `data/cache.test.ts`                           | the IndexedDB data cache: degradation without it, fingerprint/expiry invalidation, index dedupe      |
| `data/catmaid/catmaid.test.ts`                 | CATMAID against recorded bodies: decoding, refusals, a thumbnail through the Skeletons decoder       |
| `data/catmaid/live.test.ts`                    | CATMAID against the real VFB FAFB instance, skipped without `CATMAID_LIVE`                           |
| `data/catmaid/publicTokens.test.ts`            | VFB's published anonymous tokens: host coverage, a user token winning, the manifest refresh, a rotated token's fallback |
| `data/cave/cave.test.ts`                       | CAVE against recorded bodies: ids, refusals, truncation, sign-in label, discovery, morphology and skeleton-service routes, the card blurb |
| `data/cave/deployments.test.ts`                | a second CAVE deployment: one token per global server, every request naming its own                  |
| `data/cave/live.test.ts`                       | CAVE against real services (skipped without `CAVE_TOKEN`): endpoint shapes, BANC row caps, flat/graphene/L2/skeleton-service routes, auth_info |
| `data/cave/nuclei.test.ts`                     | a neuron's nucleus: position in nm, merge vs absence, a materialization asked only about new ids     |
| `data/cave/oauth.test.ts`                      | CAVE sign-in minus the window: the login prefix read off `auth_info`, refusals, terms-of-service arm, identity lookup |
| `data/cave/rootIds.test.ts`                    | the root-id drift check: wire format, UTC instant, when it re-asks, late landers                     |
| `data/csv.test.ts`                             | reading a foreign CSV: quoting, delimiter, header bias, name suffixes, values never widened          |
| `data/custom/neurons.test.ts`                  | the custom neuron table's schema half vs the table built at run time, for every id-column shape      |
| `data/datasetCache.test.ts`                    | "everything cached for this dataset" as a key question: version prefixes, oldest entry, pre-sidecar entries |
| `data/datasetListing.test.ts`                  | `DatasetListing`: one fetch per peek, no retry from a peek, an awaited caller retrying a failure     |
| `data/dvid/live.test.ts`                       | the DVID reader against the real server, skipped unless `DVID_LIVE`                                  |
| `data/dvid/refs.test.ts`                       | parsing a published DVID source into server, node and instance, and the geometry URLs                |
| `data/edges/binary.test.ts`                    | reading Parquet and Feather edge files on pyarrow's default codecs, and already-rounded ids          |
| `data/edges/encode.test.ts`                    | the edge-set encoder: rounded ids, transpose order, per-region merges — each a plausible wrong connectome, not an error |
| `data/edges/importer.test.ts`                  | the edge import driver on the no-worker path (the worker wrapper stays uncovered)                    |
| `data/edges/query.test.ts`                     | querying a loaded edge set: connectivity and the `pathStepCypher` port                               |
| `data/edges/read.test.ts`                      | edge-list text: the preview's guesses and streaming chunk boundaries (CRLF, multi-byte, final row)   |
| `data/edges/scale.test.ts`                     | the encoder at design size; allocates ~1 GB, so skipped unless `EDGE_SCALE=1`                        |
| `data/edges/store.test.ts`                     | the edge-set shelf against `fake-indexeddb`: chunk ownership, chunking, no IndexedDB, a wired set    |
| `data/edges/tableFile.test.ts`                 | an edge list read out of a table file: the three pyarrow layouts encoding to one edge set, exact ids |
| `data/ephys/abf.test.ts`                       | the ABF1/ABF2 readers on byte-built files: scaling, channels, epochs, command waveforms (real files: `pnpm probe:abf`) |
| `data/ephys/nwb.test.ts`                       | the NWB reader on files written with h5wasm: protocols, units, clamps, pairing, windows              |
| `data/ephys/recording.test.ts`                 | the stored-recording cache: parse reuse, byte budget, LRU                                            |
| `data/errorBody.test.ts`                       | `bodyExcerpt`: an HTML error page read down to its title                                             |
| `data/fetchText.test.ts`                       | `fetchText`: POST bodies, no credentials, abort, unreachable vs CORS                                 |
| `data/files/delta/delta.test.ts`               | Delta tables read through `readRows` against delta-rs's own reads (`__fixtures__/delta`), and the log's stats |
| `data/files/delta/live.test.ts`                | a Delta table on CAVE's public bucket, skipped unless `DELTA_LIVE`                                   |
| `data/files/pages.test.ts`                     | the Parquet fast path (`pages.ts`) against the library route, cell for cell, and that it was actually taken |
| `data/files/read.test.ts`                      | the lazy table-file readers on pyarrow fixtures: block skipping, fingerprints, `readRows`, the block index (and its IndexedDB copy) |
| `data/files/registry.test.ts`                  | a local file across a reload (handle permission), shared footer reads, ⟳ rereading, URL sizes        |
| `data/files/split.test.ts`                     | a keyed read split across workers answering what one pass answers                                    |
| `data/filterRows.test.ts`                      | what a Find Neurons row means: operator lowering, null rule, storage round trip, `resolveRows` refusals |
| `data/foreignColor.test.ts`                    | colours as other tools write them: CSS names, hex, RGB(A) lists, and what is not a colour            |
| `data/geometryCache.test.ts`                   | the session geometry cache: missing-id fetches, identity, LOD separation, byte LRU, streaming publication |
| `data/idDtype.test.ts`                         | invariant 8 across sources: no `i64` id column, and published *values* walked against declared dtypes (schemas validate nothing) |
| `data/idb.test.ts`                             | the shared IndexedDB opener: upgrades, an unmemoised rejected open, stepping aside for another tab, the two policies |
| `data/libraries.test.ts`                       | `lz4Frame` on hand-built frames, flag by flag                                                        |
| `data/memoPromise.test.ts`                     | `memoPromise`: a rejection never kept, `untilAborted`, `ReplayedFailures`                            |
| `data/meshDecimate.test.ts`                    | vertex clustering, and `decimateParts` byte-identical to joining first (mutation-checked; `pnpm probe:mesh-decimate`) |
| `data/meshFile.test.ts`                        | STL (ASCII/binary/welded) and PLY readers held to one icosphere                                      |
| `data/mock/generate.test.ts`                   | the synthetic connectome: determinism, internal consistency, source semantics                        |
| `data/mock/morphology.test.ts`                 | synthetic morphology: tree validity, determinism, tube meshes, synapse placement                     |
| `data/neuprint/edgeProperties.test.ts`         | neuPrint edge properties at the data layer: per-region Cypher, discovery off a sample, schema order  |
| `data/neuprint/live.test.ts`                   | which neuPrint datasets publish skeletons and both routes agreeing, skipped without `NEUPRINT_TOKEN` |
| `data/neuprint/neuprint.test.ts`               | neuPrint: Cypher building/escaping, decoding, the `bodyId`→`neuronId` seam, schema discovery, meshes, the two skeleton routes |
| `data/neuprint/roiHierarchy.test.ts`           | the ROI level above primary from the real hemibrain tree, and a malformed tree                       |
| `data/neuroglancer/frameCredentials.test.ts`   | which CAVE token a data server in Coda's neuroglancer frame is sent                                  |
| `data/neuroglancer/scene.test.ts`              | neuroglancer scene editing on real published shapes, the URL round trip, `middleauth+`, multi-volume layers |
| `data/neuroglancer/selectionEdits.test.ts`     | the Neuroglancer card's `+id`/`-id` edits: stored form, folding against the last sent scene, in-place updates |
| `data/neuroglancer/sourceUrl.test.ts`          | source specs: three spellings to one canonical key, `middleauth+`, `precomputedToHttp` staying narrower |
| `data/neuronbridge/live.test.ts`               | the NeuronBridge bucket, skipped unless `NEURONBRIDGE_LIVE`                                          |
| `data/neuronbridge/neuronbridge.test.ts`       | the NeuronBridge client against recorded `v3_10_0` responses: config, lookups, URLs, match files     |
| `data/neuronbridge/views.test.ts`              | what a NeuronBridge comparison draws: CDS/PPPM, unpublished files, mirroring                         |
| `data/nrrd.test.ts`                            | NRRD stacks: gzip/raw bodies, CRLF headers, refusals, projection, abandoning inflation               |
| `data/obj.test.ts`                             | reading a foreign OBJ: face-index forms, polygons, CRLF, a 200 that is not a mesh                    |
| `data/peeks.test.ts`                           | sweep of every credential-needing peek: tokenless it asks and reports nothing; a new peek goes in its list |
| `data/precomputed/datasource.test.ts`          | a precomputed URL as a datasource: `info` classification (incl. no `@type`), sidecars, retries, capabilities, refusals |
| `data/precomputed/live.test.ts`                | precomputed against real buckets (male-CNS, hemibrain), skipped without `PRECOMPUTED_LIVE`           |
| `data/precomputed/precomputed.test.ts`         | shard lookup, multi-LOD manifests, Draco, legacy fragments, CORS fallback, the two-phase progress split |
| `data/precomputed/skeletons.test.ts`           | the precomputed skeleton format: edge list to rooted tree, radius/affine, `uint8` compartments       |
| `data/queries.test.ts`                         | the connectivity funnel: source vs attached edge set, and the refusal when the set is not in this browser |
| `data/rawFileUrl.test.ts`                      | GitHub file links rewritten to a browser-readable raw URL                                            |
| `data/share/fragment.test.ts`                  | the `#!` share grammar and packed codec, above all its refusals; demo links                          |
| `data/share/gist.test.ts`                      | workflow gists, with `fetch` stubbed because the *request* is what matters: create, update, read, failures, login |
| `data/soma.test.ts`                            | `withSomaAt`: labelling the node nearest a soma position, cache-friendly copies                      |
| `data/swc.test.ts`                             | SWC text and rows: headers, parent order, voxels unscaled, malformed/cyclic rows, the type column    |
| `data/transforms/transforms.test.ts`           | the transform registry and the shape of its generated `manifest.json`, landmark files, the drift tripwire |
| `data/uploads.test.ts`                         | the upload store against real IndexedDB: content addressing, a rejecting write, the peek's one read  |
| `data/vfb/live.test.ts`                        | Virtual Fly Brain itself, skipped unless `VFB_LIVE` (reads only)                                     |
| `data/vfb/vfb.test.ts`                         | the VFB client: releases, type classes, term info, PDB, point clouds, image stacks                   |
| `data/workerJob.test.ts`                       | the worker seam: answers, cancels, errors, a silent death, progress, every result buffer found once  |
| `data/zapbench/live.test.ts`                   | the ZapBench reader against the real bucket, skipped unless `ZAPBENCH_LIVE`                          |
| `data/zapbench/readPlan.test.ts`               | choosing between ZapBench's two transposed layouts, and the exact byte arithmetic of each plan       |
| `data/zapbench/recording.test.ts`              | the whole-population ZapBench reader against the fake store: levels, bins, named rows, three refusals |
| `data/zapbench/traces.test.ts`                 | the ZapBench trace reader: byte arithmetic, the 1-based id base, cost, the session cache, the transposed copy |
| `data/zoo/zoo.test.ts`                         | the Zoo: layout digest, `requires`, drift errors vs warnings, the reader, and the fetch/cache/revision rules |

### Node ops (`nodes/lib`)

| File                                       | Covers                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `nodes/lib/arborDaylight.test.ts`          | the daylight arbor layout's no-Worker path matching `equalAngleLayout`                               |
| `nodes/lib/arborHeal.test.ts`              | `healSkeleton` without the Python runtime: whole skeletons untouched, pieces counted                 |
| `nodes/lib/arborLayout.test.ts`            | the arbor plot's layouts (rectangular, radial, subway, equal-angle): distances, child order, `pointOnPiece` |
| `nodes/lib/arborOps.test.ts`               | arbor building: roots, healed bridges, electrotonic distance, radii, the reduced tree, synapse projection |
| `nodes/lib/carryParams.test.ts`            | the `Carry fields` join engine shared by Split Neurons and Attach Attributes, incl. a picked right key |
| `nodes/lib/chartSelection.test.ts`         | what a chart mark is called: missing bucket, the range codec's exact round trip, half-open bars      |
| `nodes/lib/compartmentOps.test.ts`         | the axon/dendrite split's bookkeeping either side of the mocked Python engine (`pnpm probe:split` checks navis) |
| `nodes/lib/connectionCompartments.test.ts` | classifying an edge list's synapses by compartment at each end, on hand-built neurons                |
| `nodes/lib/connectivityOps.test.ts`        | the connectivity traversal, the `Neuron Set` derivation and left join, `published` filtering, `matrixToLinks` |
| `nodes/lib/copyIds.test.ts`                | what Copy IDs puts on the clipboard: dedupe order, nulls, exact ids, separators                      |
| `nodes/lib/datasetFamilies.test.ts`        | version ordering, latest vs pinned, deployment URLs; every CAVE family ↔ datastack spec, CATMAID families' sources |
| `nodes/lib/datasetStats.test.ts`           | dataset summary roll-ups (absence, residual fold, caps) and which fields get a chart                 |
| `nodes/lib/describeOps.test.ts`            | the per-column summary: schema/value agreement, missing values, the five-number spread, id columns, the memo |
| `nodes/lib/displayLabels.test.ts`          | the guard around the annotation lookup that names dendrogram leaves                                  |
| `nodes/lib/dotmotifHost.test.ts`           | how a network is keyed for DotMotif (Python never sees an id): rank keys, link order, exact ids      |
| `nodes/lib/dotmotifOps.test.ts`            | which columns a DotMotif query names                                                                 |
| `nodes/lib/edgeComparison.test.ts`         | the L2a edge comparison: absence vs unasked, the pool, `minWeight`, schema/value agreement at every arity |
| `nodes/lib/embedOps.test.ts`               | the k-NN graph handed to UMAP: self first, exact width, `-1` padding at a finite distance (all mutation-checked) |
| `nodes/lib/flowChartOps.test.ts`           | the flow chart's graph: layering (longest path or a column), labels and weights, folding             |
| `nodes/lib/geometryDistance.test.ts`       | neuron–neuron distance arithmetic against hand-worked geometry: weighting, directions, within, statistics |
| `nodes/lib/idList.test.ts`                 | reading pasted ids: separators, a bad token refusing the list, 18-digit exactness, the 19-digit ceiling |
| `nodes/lib/influenceOps.test.ts`           | bounded influence: propagation (not BFS), split hops, halves, batching, the table and the flow       |
| `nodes/lib/kdTree.test.ts`                 | the k-d tree against brute force: build, `closestPair`, `anyPairWithin`                              |
| `nodes/lib/labelLookup.test.ts`            | label parsing, the typed/wired union, the unmatched report                                           |
| `nodes/lib/labelsToNeurons.test.ts`        | labels to neurons: type expansion, text matching, repeats, collisions                                |
| `nodes/lib/lineChart.test.ts`              | the Line Chart's Y default, shared with the export plan                                              |
| `nodes/lib/linkageOps.test.ts`             | the tree ops: square-matrix refusal, exact-k cuts, leaf-order numbering, the mixed-dataset cut       |
| `nodes/lib/matrixReduce.test.ts`           | Reduce Matrix: `Group By`'s null rule, infinities, Welford spread, axes, the diagonal rule, schema/value sweep, memo |
| `nodes/lib/matrixShape.test.ts`            | the Heatmap's Filter and Order tabs without Python: the `/` opt-in, `takeMatrix`, totals, the follower by label |
| `nodes/lib/networkCentrality.test.ts`      | Brandes, PageRank, Louvain on hand-worked cases, plus networkx agreement from checked-in fixtures    |
| `nodes/lib/networkMetrics.test.ts`         | graph statistics: hand-worked decisions, then networkx agreement via `__fixtures__/networkx.json` (no Python needed) |
| `nodes/lib/networkOps.test.ts`             | network filter order, ranking after the weight cut, recomputed degree roll-ups                       |
| `nodes/lib/neuronSearch.test.ts`           | the Explore Dataset query language: parsing, matching, nulls, fuzzy fallback, ranking, completion    |
| `nodes/lib/neuronbridgePins.test.ts`       | the NeuronBridge `Pinned` port: schema/value agreement and stored-entry round trip                   |
| `nodes/lib/nodeValues.test.ts`             | the `NODE_VALUES` list: built-ins first, pack values named by pack                                   |
| `nodes/lib/partnerVectors.test.ts`         | the Partner Vectors reshape: directions, query-set edges, routes, untyped fallback, fractions, id dtype |
| `nodes/lib/pathOps.test.ts`                | the path search: bidirectional, feed-forward prune, bottleneck ranking, truncation                   |
| `nodes/lib/pointsInMeshes.test.ts`         | Points in Volumes' op: partition, the minted column (invariant 3), overlap, the ray, interruptibility, frames |
| `nodes/lib/populationParams.test.ts`       | the neuPrint population filters: `typed` by suffix, OR semantics, absent vs false, the local filter's union and identity |
| `nodes/lib/profileStats.test.ts`           | the profile roll-ups: distinct partners, nested ROIs, side rule, NT columns                          |
| `nodes/lib/similarityOps.test.ts`          | the five similarity metrics against scipy's own `pdist`, presence, layouts, pair-work count, crash floor |
| `nodes/lib/skeletonPoints.test.ts`         | Skeleton to Points: cable sums, branch points, compartments, schema/value, hand placement            |
| `nodes/lib/splitByTag.test.ts`             | splitting a skeleton by tags: distal of a tag is axon, tag names                                     |
| `nodes/lib/splitByVolume.test.ts`          | splitting a skeleton by volumes: nodes inside, margins, unmatched neurons                            |
| `nodes/lib/splitCorrections.test.ts`       | hand corrections to a split: storage, snapping, reassignment                                         |
| `nodes/lib/synapseEdges.test.ts`           | Synapses to Edges' fold: schema/value agreement, counting, orientation, refusals                     |
| `nodes/lib/tableEdits.test.ts`             | Edit Table's op: schema/value agreement, failure direction, `""` clearing a cell, rule order         |
| `nodes/lib/tableFilter.test.ts`            | a header cell's filter grammar: dtype-following values, nulls, dropped clauses                       |
| `nodes/lib/tableOps.test.ts`               | the table ops (join, coalesce, relabel, unpivot, rename, id bridge…), each with schema/value agreement — hand-written per op, no sweep |
| `nodes/lib/topologyOps.test.ts`            | skeleton topology (Strahler, segments, morphometrics) against navis-fastcore 0.13.0's transcribed output |
| `nodes/lib/transformOps.test.ts`           | moving geometry: reflection, mesh winding, bounds, the mirrored column's two halves, the real manifest |
| `nodes/lib/typeMapping.test.ts`            | the cross-dataset cell-type mapper against cocoa's worked examples, label modes, `suspicious`, oversize warning |
| `nodes/naming.test.ts`                     | every node that renames or mints columns names them in its `description`; annotation nodes saying `cell_type` arrives as `type` |

### Nodes

| File                                        | Covers                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `nodes/analysis/buildNetwork.test.ts`       | Build Network's picker defaults against every edge-list producer, and the self-loop fallback `validate` flags |
| `nodes/analysis/distance.test.ts`           | the Distance node end to end, incl. the real `three-mesh-bvh` mesh arm, cancel, and the closest-approach indexes |
| `nodes/analysis/dotmotif.test.ts`           | the DotMotif node: on demand, its fixed table, lossless ids, the match cap, only queried columns cloned |
| `nodes/analysis/embed.test.ts`              | the Embedding node against the real umap-js (no seam mocked): refusals, seeds, structure, the three routes |
| `nodes/analysis/filterNetwork.test.ts`      | Filter Network: hops and direction, components, induced links, roll-ups, the seed union              |
| `nodes/analysis/linkage.test.ts`            | the Linkage/Cut Tree nodes: controls reaching the request, the cut on the pass-through, a restyle costing no run |
| `nodes/analysis/nblast.test.ts`             | NBLAST: units conversion above all, flattening, labels, warnings, the allocation floor, the voxel refusal |
| `nodes/analysis/nblastKnn.test.ts`          | NBLAST k-NN shape: the long rectangle, padding dropped and counted, id columns named                 |
| `nodes/analysis/nblastMatches.test.ts`      | NBLAST matches: invariant 3 for three modes, `auto` direction, `n` clamped, the rectangle diagonal refusal |
| `nodes/analysis/network.test.ts`            | Build Network semantics and the selection round trip                                                 |
| `nodes/analysis/networkCentrality.test.ts`  | the Centrality node's shape: `expensive`, switch-driven columns via `centralityOptions`, determinism |
| `nodes/analysis/similarity.test.ts`         | Similarity through a real Scheduler on the mock connectome: no partner leak, `measure` to Linkage, schema before a run |
| `nodes/annotation/annotations.test.ts`      | the four annotation source nodes: the two join halves, chain shapes, refusals on the card            |
| `nodes/annotation/note.test.ts`             | a text note is never executed, deferred, stalled or counted, and round-trips                         |
| `nodes/dataset/caveTables.test.ts`          | the two CAVE discovery nodes: stable schemas, ordering, wire over field, exact ids, datastack refusals |
| `nodes/dataset/dataset.test.ts`             | dataset nodes: infer = evaluate, custom/superseded nodes, CATMAID projects, population checkboxes, a refused datastack's reason |
| `nodes/dataset/edgeSet.test.ts`             | attaching a user edge set to a dataset node: the two params, type and value both carrying it, `validate` |
| `nodes/dataset/ngsource.test.ts`            | the Neuroglancer Source node: a pasted URL registering a source, `str` ids, silent while probing, Run retrying |
| `nodes/flow/collect.test.ts`                | the Collect fold: every pass stacked, partial columns, empty passes, mismatched kinds refused        |
| `nodes/flow/forEach.test.ts`                | the For Each node: `loopPlan` and `evaluate` agreeing per pass, naming, groups, past the end, half a loop refused |
| `nodes/output/barChart.test.ts`             | the Bar Chart tap: an unpicked column warns, stack-by-itself                                         |
| `nodes/output/charts.test.ts`               | Histogram, Pie and Box nodes: taps, `Selected` keeping neurons-ness, only the selection column in the key (via the scheduler) |
| `nodes/output/datasetSummary.test.ts`       | Dataset Summary: chart settings stale nothing, `Status` does, no ports, old graphs' `chartsMode`     |
| `nodes/output/describe.test.ts`             | the Describe node's ports: the tap by identity, neurons-ness only on the tap, the summary's schema   |
| `nodes/output/download.test.ts`             | the Download tap: identity, deferred by the auto pass, settings re-run nothing                       |
| `nodes/output/flowChart.test.ts`            | the Flow Chart node: pass-through by identity, presentational controls, what only the node decides   |
| `nodes/output/heatmap.test.ts`              | the Heatmap node: filter before sort, the param split, clustering via a bridge stub, Labels tab, the Selected ports |
| `nodes/output/lineChart.test.ts`            | the Line Chart node is a tap: cheap, presentational, identity pass-through                           |
| `nodes/output/networkMetrics.test.ts`       | the Metrics node's shape: ports typed before a run, folded columns, the scatter offered the produced schema |
| `nodes/output/neuroglancer.test.ts`         | the Neuroglancer node's link: segments, colours matching the 3D view, the limit, auth                |
| `nodes/output/neuronDendrogram.test.ts`     | the Neuron Dendrogram's `evaluate`: pass-through ports and the Points port                           |
| `nodes/output/neuronbridge.test.ts`         | the NeuronBridge node as a tap: browsing invalidates nothing, pinning does, never fetches in `evaluate` |
| `nodes/output/profile.test.ts`              | Neuron Profile as a tap: paging free, pinning not                                                    |
| `nodes/output/rank.test.ts`                 | the Rank Plot node: pass-through by identity, validate's double-log catch, evaluate                  |
| `nodes/output/rois.test.ts`                 | the ROI Viewer node: no ports, controls costing no run, a source without region meshes               |
| `nodes/output/sankey.test.ts`               | the Sankey node over the Influence `Transfers` chain: identity pass-through, presentational controls |
| `nodes/output/scatter.test.ts`              | the Scatter tap: id vs row-index selection, `Vector marks` stales nothing                            |
| `nodes/output/table.test.ts`                | the Table node's two ports: the tap whole, filtering stales while paging does not                    |
| `nodes/output/viewer3d.test.ts`             | the 3D View node's shape: empty card vs inspector, tab per socket, colour defaults, opacity          |
| `nodes/query/edgeProperties.test.ts`        | edge properties through Connectivity, Adjacency and Profile against the mock's two properties        |
| `nodes/query/explore.test.ts`               | Explore Dataset's ports: `All` ignores search and `Max hits`, infer = evaluate                       |
| `nodes/query/findNeurons.test.ts`           | Find Neurons through the scheduler: rows AND, sets, legacy params folding into rows, `validate` on unknown fields |
| `nodes/query/idsFromLabel.test.ts`          | IDs from Label: exact vs regex, anchoring, the union in one query, empty meaning empty               |
| `nodes/query/inputIds.test.ts`              | Input IDs: no dataset no query, numeric seam, no status filter, empty never all                      |
| `nodes/query/morphology.test.ts`            | the morphology nodes: `Warn above`, the shared route refusal, the Skeletons `Source` param in the key |
| `nodes/query/roiMeshes.test.ts`             | ROI Meshes: omitted vs empty `rois`, dataset-driven options, refusals                                |
| `nodes/query/roiSummary.test.ts`            | the two ROI summary nodes: from a Dataset alone, unknown summability, their asymmetry                |
| `nodes/query/uploadMesh.test.ts`            | the Upload Mesh node: unit scaling in `evaluate`, ROI Meshes' columns, `validate` starting the peek  |
| `nodes/table/combine.test.ts`               | the coalesce node: infer = evaluate, unset picker warns, chain into a Dataset                        |
| `nodes/table/dedupe.test.ts`                | Dedupe: `keep` modes, whole-row comparison, order kept, null vs "null"                               |
| `nodes/table/filterFile.test.ts`            | Filter Table on a Link Table file: the deferred condition keeping exactly what `filterTable` keeps   |
| `nodes/table/fromUrl.test.ts`               | Table from URL: deferred by the auto pass, Refresh the only re-fetch, schema keyed by URL, refusals  |
| `nodes/table/groupBy.test.ts`               | Group By's computed schema = evaluate, aggregate naming, `count`, dropped columns, picker warnings   |
| `nodes/table/linkTable.test.ts`             | Link Table and Read Rows end to end on pyarrow files: pre-read schema, invariant 3, URLs             |
| `nodes/table/pivot.test.ts`                 | Pivot's two outputs describing one pivot, the wide schema by observation                             |
| `nodes/table/qualifyIds.test.ts`            | qualified ids: `isNeuronId` rejecting them, round trip, nulls, separator split, kind kept            |
| `nodes/table/reduceMatrix.test.ts`          | the Reduce Matrix node: infer = evaluate at four arities, the ignored-diagonal warning, non-matrix refusal |
| `nodes/table/relabel.test.ts`               | the Relabel node: dtype incl. `keep` widening, `unmatched` default, picker defaults, id-drift warning |
| `nodes/table/rename.test.ts`                | the Rename node: kind promotion/demotion, warnings that refuse nothing                               |
| `nodes/table/sample.test.ts`                | Sample: four modes, seeded draws, seed costing nothing elsewhere                                     |
| `nodes/table/stack.test.ts`                 | Stack Tables: union schema, dtype clash at run time, source column, pre-variadic graphs via `formerIds`/`absentMeans` |
| `nodes/table/unpivot.test.ts`               | the Unpivot node: derived schema, neurons claim dropped, warnings, Keep fallback                     |
| `nodes/table/upload.test.ts`                | the Upload node: schema by peek, `neuronId` rename, a graph opened elsewhere, filename costing nothing |
| `nodes/transform/attachAttributes.test.ts`  | Attach Attributes over the carry engine: kinds at three arities, empty = every column, `validate` on substitution |
| `nodes/transform/cleanMeshes.test.ts`       | Clean Meshes: mesh-local faces, item count, `detail` dropped, the ray-cast warning                   |
| `nodes/transform/cleanSkeletons.test.ts`    | Clean Skeletons: item count kept, neuron-local parents, µm controls, the voxel refusal, resample floor |
| `nodes/transform/labelsToNeurons.test.ts`   | the two Labels to Neurons registrations: shared params, the differing warning, neurons type for 3D   |
| `nodes/transform/landmarkTransform.test.ts` | Landmark Transform: refusals, unit conversion, the six required pickers                              |
| `nodes/transform/mirror.test.ts`            | Mirror Neurons at the graph level: where the midline comes from, refusals, the override, the spline  |
| `nodes/transform/pointsInVolumes.test.ts`   | the Points in Volumes node: schema before a Run, `validate`, the three refusals (the frame one above all) |
| `nodes/transform/selectNeurons.test.ts`     | Select Neurons: matched on the geometry's own id, the subset, the node                               |
| `nodes/transform/selectOne.test.ts`         | Select One: stepping vs committing, past the end, bounds re-measured while units/space/route carry   |
| `nodes/transform/simplifySkeletons.test.ts` | Simplify Skeletons around mocked Python: flattening, the `keep` gather, units (`scripts/probe-skeletons.mjs` runs the real one) |
| `nodes/transform/skeletonizeMeshes.test.ts` | Skeletonize Meshes around mocked Python: request buffers, scattering back, soma, the wait            |
| `nodes/transform/splitCompartments.test.ts` | Split Axon/Dendrite as a node: edit-time schema vs run, join warnings, by tag, by ROI                |
| `nodes/transform/splitNeurons.test.ts`      | Split Neurons: a true partition, asked of attributes, no rows → `Rest`, the node                     |
| `nodes/transform/stackNeurons.test.ts`      | Stack Neurons: the skeleton route kept only where every input agrees (compared by id)                |
| `nodes/transform/updateRootIds.test.ts`     | Update Root IDs: stale rows only, raw supervoxels, dtypes, other backends refused, `Method: majority` |
| `nodes/transform/xform.test.ts`             | Transform Neurons: which space, what it refuses, the hub round trip, unshipped registrations         |

### Packs

| File                                              | Covers                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packs/annotation/bigclust.test.ts`               | BigClust's `info` and node on a pyarrow-written project, and its Scene through a real Neuroglancer node (`pnpm probe:bigclust`) |
| `packs/annotation/routing.test.ts`                | which of a selection's neurons an Annotate target answers for                                        |
| `packs/annotation/targets.test.ts`                | an Annotate card's stored targets: tolerant reads, per-kind settings, what each still needs          |
| `packs/biophys/build.test.ts`                     | the Compartment Model builder on a synthetic neuron: soma, fragments, inputs by role, channels, regions, synapse sockets |
| `packs/biophys/fit.test.ts`                       | the passive fit on recordings from a known membrane: recovery within errors, fixed params, the seal, refusals |
| `packs/biophys/fitOps.test.ts`                    | Fit Model Passive's tables and conversions, what Apply writes, and the node end to end               |
| `packs/biophys/fitPool.test.ts`                   | the fit's worker pool against a stand-in `Worker`: ordering, setup once, errors, cancel, no-Worker fallback |
| `packs/biophys/glyphs.test.ts`                    | the biophysics glyphs held to the Skeletons drawing they copy                                        |
| `packs/biophys/modelStats.test.ts`                | the Model tab's numbers and `modelCable` drawing data                                                |
| `packs/biophys/recordingOps.test.ts`              | Load Recording's table: sweep ranges, windows, block means, schema agreement, the crash-floor issue  |
| `packs/biophys/regions.test.ts`                   | painted regions: `upTo`, the soma's start, ignored subtrees, stroke round trip                       |
| `packs/biophys/simulate.test.ts`                  | Simulate Model: trains, record sites, `planRun`, the job, arbour peaks, movie, injection, schema agreement |
| `packs/biophys/simulateCurrent.test.ts`           | Simulate Model's Current socket: breakpoints, sweeps, sites, unit pickers, schema before a run       |
| `packs/biophys/synapseParams.test.ts`             | the two synapse sockets as params: id prefixes, presets, refusals                                    |
| `packs/biophys/traceOps.test.ts`                  | Combine Traces: naming, resampling onto a grid, sweep spreading, schema agreement                    |
| `packs/connectome/adjacency.test.ts`              | Adjacency's two outputs from one fetch: Links typed before a run, one row per non-zero cell, requested ids |
| `packs/connectome/compareConnectivity.test.ts`    | Compare Connectivity: adjacent socket pairs, hidden per-dataset params, name collisions, infer = evaluate per arity |
| `packs/connectome/connectionCompartments.test.ts` | the Connection Compartments node through the scheduler on the mock connectome                        |
| `packs/connectome/connectivity.test.ts`           | the Connectivity node: advertised columns, Hops, `full` re-keying, `Include fragments`               |
| `packs/connectome/customDataset.test.ts`          | the Custom Dataset node end to end: neuron table + geometry elsewhere, edge lists, synapse tables    |
| `packs/connectome/influence.test.ts`              | the Influence node through the scheduler: shape, budget, denominators, per-seed channels — repeats tested *interleaved* |
| `packs/connectome/matchTypes.test.ts`             | Match Cell Types: growing port sets, report schema, refusals before fetching, the Pass Through port  |
| `packs/connectome/paths.test.ts`                  | the Paths node end to end; the collapse reaching the source                                          |
| `packs/connectome/synapseEdges.test.ts`           | the Synapses to Edges node: schema before a run, `validate`'s partnerless catch, refusals            |
| `packs/connectome/synblast.test.ts`               | SynBLAST: grouping by synapse rows, orphans, text ids, µm conversion, polarity, `by_type`            |
| `packs/cortex/cellTypes.test.ts`                  | the gallery's `Cell types` choice as table reads, and the schema before any read                     |
| `packs/cortex/cells.test.ts`                      | the gallery's cells: depth and layer, wall grouping, ordering, seeded samples, compare pairs         |
| `packs/cortex/frames.test.ts`                     | cortical frames against `standard_transform` 2.0.0, layers by depth, frames per dataset              |
| `packs/cortex/gallery.test.ts`                    | the gallery's Skeletons carrying each cell's row, offered before a run                               |
| `packs/cortex/live.test.ts`                       | every declared MICrONS typing table read live, with `CAVE_TOKEN`                                     |
| `packs/cortex/pointDepth.test.ts`                 | Cortical Depth: schema/value agreement, soma placement, typing synapse ends                          |
| `packs/cortex/profileSelection.test.ts`           | Laminar Profile's stored selection: a depth range within one facet                                   |
| `packs/packs.test.ts`                             | the packs as a set: directories, type prefixes, drawings and See also kept in-pack, ZapBench's rename, shortcuts |
| `packs/vfb/vfb.test.ts`                           | the VFB pack's nodes against a stubbed PDB: what they ask as well as return, schema halves           |
| `packs/zapbench/cells.test.ts`                    | the ZapBench cell-id grammar: row labels, pasted lists, release bounds                               |
| `packs/zapbench/neuronTraces.test.ts`             | Neurons to ZapBench Traces: the seam — a wrong `zapbenchId` column, the off-by-one, cost, missing ids |
| `packs/zapbench/neurons.test.ts`                  | ZapBench neurons: the request (members, integers, no population filter), order, batching, refusals   |
| `packs/zapbench/traces.test.ts`                   | the ZapBench Traces card: order, repeats, scales, the cost sentence, `validate`'s matrix ceiling     |

### Biophysics solver (`src/biophys`)

| File                           | Covers                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `biophys/channels.test.ts`     | the channel library against Jaxley and Günay et al.'s NEURON files, shifts by gate role, Q10         |
| `biophys/discretize.test.ts`   | the compartment cut: d_lambda against NEURON's rule, exact cone areas, `compartmentAt`, refusals     |
| `biophys/leastSquares.test.ts` | bounded Levenberg–Marquardt on problems with known answers                                           |
| `biophys/modFile.test.ts`      | the NEURON `.mod` files match what each channel's spec writes (`pnpm biophys:mods`)                  |
| `biophys/solver.test.ts`       | the integrator against NEURON 8.2 on the committed fixture (`pnpm biophys:reference`), closed forms, clamps, fly channels |

### Exporters

| File                                   | Covers                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `export/live.test.ts`                  | a fixture's graph run live and both documents beside it, for `pnpm probe:catmaid` / `probe:cave` / `probe:flytable`; skipped unless `EXPORT_LIVE` names one |
| `export/dotmotif.test.ts`              | DotMotif's export in both languages: query quoting, the cap, its outputs                             |
| `export/neuroglancer.test.ts`          | the Neuroglancer node's answers recorded to `__fixtures__/neuroglancer.json` for the py/R helper probes |
| `export/plans/analysis.test.ts`        | Similarity, Embedding, Linkage, Cut Tree and smaller analysis export plans on branches no fixture takes |
| `export/plans/explore.test.ts`         | Explore's Hits and Selected export plans                                                             |
| `export/plans/heatmap.test.ts`         | the Heatmap export plan on branches no fixture takes                                                 |
| `export/plans/query.test.ts`           | dataset and query export plans: unknown families, "Latest" notes, pasted ids, skeleton layers        |
| `export/plans/stack.test.ts`           | the Stack export plan; every plan suite builds its context with `plans/testContext.ts`, typed rather than cast |
| `export/plans/table.test.ts`           | the table transforms' export plans: unset-picker refusals, operators, collation, GitHub raw links    |
| `export/plans/viewers.test.ts`         | the viewers' export notes: empty selections, pickers a chart needs, ignored filters                  |
| `export/python/coverage.test.ts`       | the drift tripwire: every node type has a notebook emitter (or is a declared gap)                    |
| `export/python/edgeProperties.test.ts` | edge properties exported to the notebook through the canvas's own query                              |
| `export/python/export.test.ts`         | the notebook goldens, ports declared, every emitting type reached, the population filter matching the canvas |
| `export/python/ports.test.ts`          | every port id an emitter names exists on its node                                                    |
| `export/r/coverage.test.ts`            | the R drift tripwire, at the notebook's bar                                                          |
| `export/r/edgeProperties.test.ts`      | edge properties in the R document via `neuprint_fetch_custom`                                        |
| `export/r/export.test.ts`              | the R Markdown goldens and the population filter in R's two spellings                                |
| `export/trimHelpers.test.ts`           | trimming a helper to the members a document refers to: Python methods and R functions, private closure, conditional `needs` |

### Assistant, MCP, Pyodide and the wizard

| File                          | Covers                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `assistant/assistant.test.ts` | the headless assistant: plan format and applier refusals, the catalogue against the registry, the digest's guards |
| `assistant/live.test.ts`      | the assistant against a real provider, gated on `ASSISTANT_LIVE=1` separately from the key; read for output |
| `mcp/contract.test.ts`        | the `coda-mcp` build's v1 exports, offline: a plan applied, checked, described and packed into a link |
| `pyodide/dotmotif.test.ts`    | the DotMotif worker seam: request, cancel, progress, refusals passed through                         |
| `pyodide/topology.test.ts`    | the compartment vocabulary and navis defaults agreeing between JS and `topology.py`                  |
| `pyodide/warp.test.ts`        | `warpPoints` against a bridge that transfers (detaches) its buffers                                  |
| `wizard/attachChain.test.ts`  | attaching an annotation chain to a dataset node on the canvas, and the stale-labels warning offering it |
| `wizard/contribute.test.ts`   | the wizard's pack extension point refusing un-namespaced or duplicate ids                            |
| `wizard/curated.test.ts`      | the hand-written demos run for real: every output of the focus card non-empty                        |
| `wizard/demo.test.ts`         | the per-node demo workflows: coverage, graphs, plan replay, the arrival state, chains                |
| `wizard/starters.test.ts`     | the starters as wizard answers: nodes, scenes, chains, captions, the known cold-start warning        |
| `wizard/wizard.test.ts`       | every Workflow Wizard combination: inference-clean, run on synthetic data, hints, caps, the pack gate |

### Style

| File                         | Covers                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `style/encoding.test.ts`     | palette rules (cycle vs fold, area, nulls, `hash`, the five palettes) and `resolveShape` |
| `style/format.test.ts`       | number formatting: ids verbatim, counts grouped, the length ladder                       |
| `style/segmentColor.test.ts` | neuroglancer's segment hash pinned to specific (18-digit) ids                            |
| `style/socketStyle.test.ts`  | the socket vocabulary and its one table, with no stylesheet transcribing it              |

### Cards (`ui/nodes`)

| File                                    | Covers                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ui/nodes/annotateBody.test.tsx`        | the Annotate card in the real editor against an in-memory target                                     |
| `ui/nodes/annotateSession.test.ts`      | an Annotate card's per-target undo stack and edited-cell tracking                                    |
| `ui/nodes/cacheAge.test.tsx`            | `cached 3d ago ⟳`: restored age, both caches cleared                                                 |
| `ui/nodes/cardChrome.test.ts`           | card-chrome pixel rules: clip bleed vs hit target, socket symmetry, the header palette across stylesheets |
| `ui/nodes/caveDatastackField.test.tsx`  | the Custom CAVE card: its face, Datastack completion, and no request without a token                 |
| `ui/nodes/caveTableInfoBody.test.tsx`   | the CAVE table info card: row counts, views, five absences told apart                                |
| `ui/nodes/collapsedPorts.test.tsx`      | collapsing to a header: handles moved not removed, width kept                                        |
| `ui/nodes/copyIdsBody.test.tsx`         | the Copy IDs card                                                                                    |
| `ui/nodes/datasetBody.test.tsx`         | the dataset card: preview, version dropdown, resolved id, the population summary line                |
| `ui/nodes/datasetCacheAge.test.tsx`     | the dataset card's cache age: read from the cache, starts no download                                |
| `ui/nodes/descriptionBody.test.tsx`     | the Description card: links, nesting, the overlay, no raw HTML                                       |
| `ui/nodes/editTableBody.test.tsx`       | the Edit Table card's rule rows                                                                      |
| `ui/nodes/findNeuronsBody.test.tsx`     | the Find Neurons card's rows (`FilterRowsEditor`) and legacy conversion                              |
| `ui/nodes/hiddenParams.test.tsx`        | the `… N more` hint                                                                                  |
| `ui/nodes/idsFromLabelBody.test.tsx`    | the IDs from Label card                                                                              |
| `ui/nodes/inputIdsBody.test.tsx`        | the Input IDs card                                                                                   |
| `ui/nodes/labelsToNeuronsBody.test.tsx` | the Labels to Neurons readout                                                                        |
| `ui/nodes/nodeHints.test.tsx`           | docked hints: dismissal leaves the graph identical (localStorage, keyed on text), the ✎ editor       |
| `ui/nodes/nodeResize.test.tsx`          | resize handles, a resize not invalidating, gesture undo                                              |
| `ui/nodes/nodeRunRing.test.tsx`         | run-indicator arithmetic: dash fractions, zero floor, indeterminate                                  |
| `ui/nodes/noteCard.test.tsx`            | the note card                                                                                        |
| `ui/nodes/paramFold.test.tsx`           | folding a card's param rows: one undo step, no run                                                   |
| `ui/nodes/paramTabs.test.tsx`           | the card's tab strip: threshold, swapping, the union equalling the flat band                         |
| `ui/nodes/pathsBody.test.tsx`           | the Paths card's four settings and caption (a body draws no generic rows)                            |
| `ui/nodes/portPreview.test.ts`          | an output port's hover content per value kind: `describeValue` headline, the pivoted panel           |
| `ui/nodes/portPreviewHover.test.tsx`    | the port-hover gesture in the real editor: delay, nothing before a run, dismissals                   |
| `ui/nodes/renameBody.test.tsx`          | the Rename card's rows                                                                               |
| `ui/nodes/resultDownload.test.tsx`      | the card foot's ⤓                                                                                    |
| `ui/nodes/runRing.placement.test.tsx`   | the run outline rendering outside the clipped card (slow mock so `running` is observable)            |
| `ui/nodes/runWarning.test.tsx`          | run warnings on the card and inspector, and `nodeIssues`' ranking                                    |
| `ui/nodes/selectOneBody.test.tsx`       | the Select One pager card                                                                            |
| `ui/nodes/skeletonSource.test.tsx`      | the Skeletons card's `Source` dropdown and route footer                                              |
| `ui/nodes/socketAgreement.test.tsx`     | a wire and its sockets drawn as one type, over a graph built to *contain* `any` ports (the demo alone passes either way) |
| `ui/nodes/splitNeuronsBody.test.tsx`    | the Split Neurons card: the attribute-table field list, the foot line                                |
| `ui/nodes/uploadBody.test.tsx`          | the Upload card's states and size ceiling                                                            |
| `ui/nodes/uploadMeshBody.test.tsx`      | the Upload Mesh card                                                                                 |

### Viewers (`ui/viewers`)

| File                                         | Covers                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ui/viewers/ambientOcclusion.test.ts`        | the AO pass's override of an undeclared three method, and its sizing helpers                         |
| `ui/viewers/arborPlot.test.ts`               | the arbor plot's arithmetic: fit, zoom/pan, picking, synapse marks, widths                           |
| `ui/viewers/arborScene.test.ts`              | the arbor plot's scene: colouring, branch groups, the synapse key, SVG                               |
| `ui/viewers/boxStats.test.ts`                | box/violin/swarm statistics: type-7 quantiles, whiskers, KDE, swarm packing                          |
| `ui/viewers/cameraMemo.test.ts`              | the 3D camera memo: per viewer, reset, LRU                                                           |
| `ui/viewers/canvasScale.test.tsx`            | `CardCanvasScale` following the zoom once it settles                                                 |
| `ui/viewers/chartViewers.test.tsx`           | Histogram, Pie and Box in jsdom: marks, hit areas, legends, captions, what a click writes back       |
| `ui/viewers/componentPack.test.ts`           | shelf packing of network components                                                                  |
| `ui/viewers/datasetSummary.test.tsx`         | the Dataset Summary card                                                                             |
| `ui/viewers/dendrogram.test.tsx`             | the dendrogram card through `ValuePreview`: clicks, captions, zoom surface, leaf naming              |
| `ui/viewers/dendrogramLayout.test.ts`        | dendrogram brackets and the leaf-axis zoom window                                                    |
| `ui/viewers/describeViewer.test.tsx`         | which port the Describe card draws                                                                   |
| `ui/viewers/drawLimits.test.ts`              | the per-draw index cap (`drawRanges`) and shared normals                                             |
| `ui/viewers/flexLineMaterial.test.ts`        | the fat-line shader patch sites still matching three's shaders                                       |
| `ui/viewers/flowChartLayout.test.ts`         | the flow chart's Sugiyama layout and routing (browser half: `pnpm probe:flowchart-draw`)             |
| `ui/viewers/heatmapPlot.test.ts`             | the heatmap fold, palettes, zoom window, colour domain, selection bands (gesture: `pnpm probe:heatmap-select`) |
| `ui/viewers/histogramBins.test.ts`           | histogram binning                                                                                    |
| `ui/viewers/layoutMemo.test.ts`              | a settled network layout returned only while it describes the graph                                  |
| `ui/viewers/lineChartViewer.test.tsx`        | the Line Chart rendered: paths, key, crosshair, zoom, strips, Y2                                     |
| `ui/viewers/lineSeries.test.ts`              | the Line Chart's series rules, M4 decimation, crosshair, zoom/pan                                    |
| `ui/viewers/liveRenderers.test.tsx`          | one live WebGL renderer per node across card, inspector and overlay; streaming from inputs           |
| `ui/viewers/markGeometry.test.ts`            | generated GLSL and polygons describing the same marks                                                |
| `ui/viewers/materialOpacity.test.ts`         | fading an already-drawn three material (real materials, no WebGL)                                    |
| `ui/viewers/meshPicking.test.ts`             | the mesh pick tree, leaving the shared index array untouched                                         |
| `ui/viewers/networkColor.test.ts`            | the network-only colour modes: components, endpoint colours                                          |
| `ui/viewers/networkContextMenu.test.tsx`     | the network context menu's rows                                                                      |
| `ui/viewers/networkDrag.test.ts`             | network node dragging arithmetic                                                                     |
| `ui/viewers/networkDraw.test.ts`             | network drawing: curvature, arrows, exported SVG sharing `markPath`                                  |
| `ui/viewers/networkLayout.test.ts`           | network layouts, incl. prefuse components separated at forty triangles (fewer passes without the feature) |
| `ui/viewers/networkMetrics.test.tsx`         | the metrics card drawing from its input, its plots and tiles                                         |
| `ui/viewers/networkRebuild.test.tsx`         | restyling never re-running the network layout, counted                                               |
| `ui/viewers/networkSelect.test.ts`           | the network context menu's selection scopes                                                          |
| `ui/viewers/networkStyle.test.ts`            | network focus/ego sets, dimming, tooltips                                                            |
| `ui/viewers/networkViewer.test.tsx`          | the network caption and the Cytoscape Web dialog                                                     |
| `ui/viewers/neuroglancerViewer.test.tsx`     | the Neuroglancer frame: restyle navigates, Reload remounts, card-to-overlay state hand-off           |
| `ui/viewers/neuronBridgeViewer.test.tsx`     | the NeuronBridge card's wiring against recorded responses (no pixels)                                |
| `ui/viewers/neuronDendrogramViewer.test.tsx` | the Neuron Dendrogram card against a fake source: fetch, clicks, Distal tab, partners                |
| `ui/viewers/persistentRoots.test.ts`         | `PersistentCanvas` lease/park/release rules, with counters for roots                                 |
| `ui/viewers/pieLayout.test.ts`               | pie tally, size fold, the full circle                                                                |
| `ui/viewers/pointSearch.test.ts`             | the scatter search's matching                                                                        |
| `ui/viewers/pointsEditor.test.tsx`           | Skeleton to Points' hand placement                                                                   |
| `ui/viewers/prefuseForce.test.ts`            | prefuse's simulation: Barnes–Hut, coincident points, determinism                                     |
| `ui/viewers/profileViewer.test.tsx`          | the Neuron Profile widget                                                                            |
| `ui/viewers/rankSeries.test.ts`              | the rank plot's ranking and share: signed columns, flags, drops by reason                            |
| `ui/viewers/roiOutlines.test.ts`             | ROI outlines kept after the meshes are released                                                      |
| `ui/viewers/roiProjection.test.ts`           | ROI projections: planes, notches, the explode, volume                                                |
| `ui/viewers/roiStyle.test.ts`                | the ROI hue rules                                                                                    |
| `ui/viewers/rois.test.tsx`                   | the ROI card: asking before 60 MB, compact rail, volume estimate                                     |
| `ui/viewers/sankeyFlow.test.ts`              | reading a table as layered flow: (layer, label) nodes, folds keeping totals                          |
| `ui/viewers/sankeyLayout.test.ts`            | Sankey geometry: one scale, shortfall on the node's bar, edge columns                                |
| `ui/viewers/scatterDraw.test.ts`             | scatter markers, batching, exported SVG                                                              |
| `ui/viewers/scatterLabels.test.ts`           | scatter point-label placement                                                                        |
| `ui/viewers/scatterPlot.test.ts`             | scatter scales, culling, trend, lasso                                                                |
| `ui/viewers/scatterRaster.test.ts`           | the scatter CPU pixel pass, and the GPU pass declining without WebGL2                                |
| `ui/viewers/scatterRebuild.test.tsx`         | scatter rebuilds: nothing on an unrelated render, frame not marks on pan                             |
| `ui/viewers/scatterViewer.test.tsx`          | the scatter caption, legend, tooltip and search                                                      |
| `ui/viewers/sceneMemo.test.ts`               | the neuroglancer state memo outliving its iframe                                                     |
| `ui/viewers/splitEditor.test.tsx`            | Split Axon/Dendrite's expanded view: a click writing a correction                                    |
| `ui/viewers/svgBuilders.test.ts`             | every synthesised export through the real serializer                                                 |
| `ui/viewers/synapseHighlight.test.ts`        | which synapses light up for a partner                                                                |
| `ui/viewers/tableSummary.test.tsx`           | the inspector's text readout of a table                                                              |
| `ui/viewers/tooltipPoint.test.ts`            | tooltip coordinates relative to the containing block and zoom                                        |
| `ui/viewers/topologyViewer.test.tsx`         | the Neuron Topology widget: measurements, pager, the split, partner highlighting                     |
| `ui/viewers/useSettledFetch.test.tsx`        | `useSettledFetch` cancellation: unshared aborted, cached never                                       |
| `ui/viewers/viewer3dScene.test.ts`           | the 3D viewer's testable half: segments, colour buffers, picking, framing, legend gestures, captions |
| `ui/viewers/viewers.test.tsx`                | chart geometry: bar cap, rounded end, 2px gaps, legend rules                                         |

### Shell, panels and other UI

| File                                      | Covers                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ui/App.smoke.test.tsx`                   | the real app mounted and driven: Run, live filtering, link rejection, undo, per-node run             |
| `ui/biophys/channelsEditor.test.tsx`      | the Compartment Model's channel editor                                                               |
| `ui/biophys/clampPreview.test.tsx`        | the Clamp tab's preview, and every `tabFigures` key naming a real tab                                |
| `ui/biophys/fitApply.test.tsx`            | Fit Model Passive's Apply: one undo step, re-offered on undo, refusal reasons                        |
| `ui/biophys/modelView.test.tsx`           | the Compartment Model's Regions/Channels/Model view (the click needs layout: probe)                  |
| `ui/biophys/movie.test.ts`                | Playback's rules: one scale, rest-relative colours, the traces table, synapse arrivals               |
| `ui/biophys/partnerRows.test.ts`          | Simulate Model's partner table as data: order, summary join, filter grammar, sorting, ticks          |
| `ui/biophys/simulatePartners.test.tsx`    | the partner table rendered: counts, ticks, bulk buttons, empty states                                |
| `ui/biophys/simulateSites.test.tsx`       | Simulate Model's Sites tab: site order, ticks, injection on/off in one commit                        |
| `ui/biophys/simulateView.test.tsx`        | Simulate Model's tabs before a run                                                                   |
| `ui/clipboard.test.tsx`                   | copy/cut/paste gestures: text selections and fields left alone, one-step cut, placement, non-graph paste falls through, the lock |
| `ui/columnLinks.test.ts`                  | `columnHref`: DOIs whole, VFB/FlyBase ids linked                                                     |
| `ui/compartmentInk.test.ts`               | the 3D View's compartment colours, key and caption                                                   |
| `ui/cortex/laminarProfile.test.ts`        | Laminar Profile's headless half: the depth axis, a layer's count agreeing with its range             |
| `ui/cortex/laminarProfileViewer.test.tsx` | Laminar Profile rendered: draws once measured, a panel per facet, click selection (geometry is the browser probe's) |
| `ui/cortex/wall.test.ts`                  | the gallery wall's arithmetic: centring, inks, µm columns, packing, justification                    |
| `ui/cortex/wallSvg.test.ts`               | the gallery's exported SVG figure                                                                    |
| `ui/cytoscapeWeb.test.ts`                 | the Open in Cytoscape Web link read back as the far end reads it, and the toggles' effect on the file |
| `ui/dashboard/dashboard.test.tsx`         | the mounted grid: canvas unmounted, cells, shortcuts, saved view; a run *underneath* the grid; the run bar (its stub must return one object) |
| `ui/dashboard/gridGeometry.test.ts`       | the dashboard's resize and drop arithmetic, and row heights tiling the area                          |
| `ui/edgeRoute.test.ts`                    | a wire's geometry: fillets clamped, ends on the sockets                                              |
| `ui/edgeRouting.test.tsx`                 | both routings drawn, hit path following the detour, routed-wire marking                              |
| `ui/explore/chips.test.ts`                | Explore chips: hues matching `colors.ts`, slots, backend vocabularies, the tags column               |
| `ui/explore/explore.test.tsx`             | the Explore widget: filtering, paging, selection, populations, blank tiles, the editable header, hover, in the real editor |
| `ui/explore/exploreMap.test.tsx`          | Explore's screen map: finders scoped to the overlay, checked by containment *and* by rect with outside pushed away (`pnpm probe:screen-map`) |
| `ui/explore/markPreview.test.tsx`         | a row mark's hover preview drawn on its own (placement: `pnpm probe:explore-columns`)                |
| `ui/explore/neuronRow.test.tsx`           | what an Explore row draws: tags, capped chips, scaled stats                                          |
| `ui/explore/previewPlacement.test.ts`     | where the hover preview lands (the left-preferring arm), at real window widths                       |
| `ui/explore/rotation.test.ts`             | the rocking preview's arithmetic, headless                                                           |
| `ui/explore/rowColumns.test.ts`           | the expanded list's column model and its edits, headless (layout: `pnpm probe:explore-columns`)      |
| `ui/explore/rowPlots.test.ts`             | the inline row marks' arithmetic: shares, bar fractions, histograms, axes                            |
| `ui/explore/rowRois.test.ts`              | folding per-region rows into one bar per neuron: nesting filter, shared ranking                      |
| `ui/explore/thumbnail.test.ts`            | silhouettes, the row spec, and the skeleton rasteriser sharing `fitToTile` with meshes               |
| `ui/export.test.ts`                       | CSV quoting/nulls/chunking, wide-matrix CSV, filenames, standalone SVG                               |
| `ui/exportValue.test.ts`                  | value exports: SWC, OBJ, JSON, GraphML, CX2, the file cap                                            |
| `ui/exportWarnings.test.ts`               | at most one exporter walk per (graph, language)                                                      |
| `ui/fileSink.test.ts`                     | a loop's file route: folder handle against a fake, `..` contained, the sink claimed once             |
| `ui/fitOnLoad.test.tsx`                   | the fit request spent: `fitView` on every open, not on an edit                                       |
| `ui/fullscreen.test.tsx`                  | ⛶ and `F`: the element handed over, a refusal, the manifest scope                                    |
| `ui/glyphs.test.ts`                       | the per-node drawing table: keys match the registry, stroke compensation, both renderers agreeing    |
| `ui/help/helpOverlay.test.tsx`            | the `?` overlay: presence, figures from the registry, cross-references, a node with no document      |
| `ui/hoverPlacement.test.ts`               | shared hover-panel placement (right arm); `useHoverPanel` deliberately has no suite — tested through its two callers |
| `ui/issueText.test.tsx`                   | a message on a surface: a real CAVE refusal reaching a card as a link, `nodrag`, copy                |
| `ui/linkify.test.ts`                      | where a message's links are: trailing punctuation, href = text, schemes, brackets                    |
| `ui/modal.test.tsx`                       | `Modal`'s ways out and Escape ownership; `ContextMenu` clamping its measured box                     |
| `ui/nodeValueShading.test.ts`             | the 3D View's `by node value` colours: one scale across skeletons, the ramp controls, grey for no number |
| `ui/notify.test.ts`                       | run notifications and the tab-title flash                                                            |
| `ui/panels/addMenu.test.tsx`              | the canvas **+** menu: derived rail and bands, snake order                                           |
| `ui/panels/alignTools.test.tsx`           | the align grid on screen: selection, undo, floors, the lock, frames                                  |
| `ui/panels/assistant.test.tsx`            | the assistant drawer against a stubbed API, incl. what the request body carries                      |
| `ui/panels/autoRun.test.tsx`              | auto-run: the default, bursts, superseded runs, an edit during a Run with it off                     |
| `ui/panels/caveSignIn.test.ts`            | the CAVE login window's four endings through the `openWindow` seam                                   |
| `ui/panels/dock.test.tsx`                 | the pinned viewer dock: exclusivity with the overlay, drops, the width                               |
| `ui/panels/edgeMenu.test.tsx`             | the link menu                                                                                        |
| `ui/panels/edgeSetPanel.test.tsx`         | the Edge data panel: attaching as one undo step                                                      |
| `ui/panels/fitSelected.test.tsx`          | Fit Selected via rail, key and palette                                                               |
| `ui/panels/fuzzy.test.ts`                 | fuzzy match/ranking, incl. boundary alignment                                                        |
| `ui/panels/groupMenu.test.tsx`            | groups on screen: frames, folding, promoted controls, the peek, run indicators                       |
| `ui/panels/guides.test.tsx`               | the first-run guides dialog's sequence with the start page and guides                                |
| `ui/panels/hintEditor.test.tsx`           | the hint editor and Add Hint… row                                                                    |
| `ui/panels/layoutControls.test.tsx`       | the layout rail, auto-layout, and the builder's one-shot arrange                                     |
| `ui/panels/library.test.tsx`              | library menus and the start-page rail                                                                |
| `ui/panels/lock.test.tsx`                 | the lock on screen: what stays live, keys that explain                                               |
| `ui/panels/memory.test.tsx`               | the memory readout and dialog (no `performance.memory` in jsdom), the Storage tab                    |
| `ui/panels/narrow.test.tsx`               | the narrow shell: `NARROW_QUERY`, the `⋯` fold, `submenuPlacement` (document width: `pnpm probe:mobile`) |
| `ui/panels/neuprintSignIn.test.ts`        | the neuPrint DatasetGateway sign-in's own contract (window machinery is `caveSignIn.test.ts`)        |
| `ui/panels/nodeBrowser.test.tsx`          | the node browser: rows, thumbnails, signatures, chip search, entry points                            |
| `ui/panels/nodeMenu.test.tsx`             | the node menu's two caches                                                                           |
| `ui/panels/notebookExport.test.tsx`       | the notebook export menu and its per-format warning                                                  |
| `ui/panels/overlay.test.tsx`              | the viewer overlay: expand/close, rail params, restyling not staling                                 |
| `ui/panels/palette.test.tsx`              | the command palette: `disabled` vs live state, node items, Space flow, export rows' peek             |
| `ui/panels/panels.test.tsx`               | shell panels, incl. the New menu's backend submenus and hidden-datasets row                          |
| `ui/panels/pluginsDialog.test.tsx`        | the Plugins dialog and shortcuts: defaults, requirements, cross-tab switches                         |
| `ui/panels/privacy.test.tsx`              | the Data & Privacy dialog: the citation half's claims, the data notice                               |
| `ui/panels/recipes.test.tsx`              | the recipe surfaces: menus, dialog, palette, wire-drop, Manage Recipes                               |
| `ui/panels/shortcuts.test.tsx`            | the shortcuts table and card, `formatChord`, keys dispatched at the window                           |
| `ui/panels/smallScreen.test.tsx`          | the small-screen notice: thresholds in both orientations, standing the guides down                   |
| `ui/panels/sources.test.tsx`              | the Connections dialog: tabs per source and pack, where an auth failure lands                        |
| `ui/panels/startPage.test.tsx`            | the start page: rails, tiles, dismissal, field-guide links against `BASE_URL`                        |
| `ui/panels/wizardDialog.test.tsx`         | the wizard dialog: hidden-datasets note, the view question's refusals, the summary checkboxes        |
| `ui/panels/workflowTabs.test.tsx`         | the workflow switcher's right-click menu                                                             |
| `ui/panels/zoo.test.tsx`                  | the Zoo browser: tokens, search, replace prompt, drift notice, offline states                        |
| `ui/params/columnField.test.tsx`          | a column picker on a port with no schema: the value it will use, never disabled                      |
| `ui/params/comboField.test.tsx`           | the filterable suggestion list and chip list behind `StringParam`                                    |
| `ui/params/paramGroups.test.ts`           | tabs/rows reshaping: every param exactly once, arity-driven tabs                                     |
| `ui/params/suppliedField.test.tsx`        | a string field a wire answers for (`StringParam.supplied`)                                           |
| `ui/raster.test.ts`                       | triangles/lines to masks to outlines, and `drawSegment`'s properties                                 |
| `ui/share.test.tsx`                       | the Share dialog both ends in the real editor: advisories, gist half, opening a link                 |
| `ui/shortcutRoute.test.ts`                | `?shortcut=` followed from the address                                                               |
| `ui/storageReadout.test.ts`               | what the Storage tab reads out of `localStorage`                                                     |
| `ui/tour/mapLayout.test.ts`               | Screen Map label placement over invented rects (browser half: `pnpm probe:screen-map`)               |
| `ui/tour/screenMap.test.tsx`              | the Screen Map against the real `App`: every finder resolving, borrow/restore, hover matched by `data-spot` |
| `ui/tour/tour.test.tsx`                   | the guided tours: built graphs, dashboard cell order, interactive steps via `describe.each` over every tour |
| `ui/useDownloads.test.tsx`                | the Download side effect: written on an executing run only, the auto-run warning                     |
| `ui/useForEach.test.ts`                   | a loop pass's files: naming, region, `On run`, nowhere to write                                      |
| `ui/useListNav.test.tsx`                  | `useListNav`'s `skip`                                                                                |
| `ui/useNeuronIndex.test.tsx`              | one neuron-index load across widgets, late mounts, reloads                                           |
| `ui/usePinchToCanvas.test.tsx`            | `usePinchToCanvas`: a pinch reaching React Flow's zoom past `nowheel`                                |
| `ui/vfb/lineGalleryViewer.test.tsx`       | the VFB Line Gallery card's wiring (jsdom loads no images)                                           |
| `ui/vfb/termHover.test.tsx`               | a VFB term in a table: the link and the on-open hover lookup                                         |
| `ui/vfb/vfbInfoViewer.test.tsx`           | the VFB Info card against VFBquery's recorded MBON01 answer                                          |
| `ui/viewerSvgTitle.test.ts`               | source rule over every viewer: a chart names itself with `aria-label`, never a root `<title>`        |
| `ui/whatsNew.test.ts`                     | `decideWhatsNew` and the seen date                                                                   |
| `ui/zip.test.ts`                          | the zip writer read back from its central directory, CRC, determinism                                |

### Static pages and help

| File                                | Covers                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `changelog/changelog.test.ts`       | the changelog's tripwires: demo links, captured images, plain-text summaries                         |
| `datasetguide/datasetGuide.test.ts` | the Dataset Guide held to the registry (it repeats three family fields)                              |
| `help/help.test.ts`                 | the help documents against the registry: names, figures, cross-references, images, raw-source callout checks |
| `help/seeAlso.test.ts`              | the See Also relation: symmetric, every entry opens something, no dead ends                          |
| `mcppage/mcpPage.test.ts`           | the MCP page's tripwires                                                                             |
| `nodeguide/anatomy.test.ts`         | the "Reading a card" figure held to the editor's chrome (arrangement: `pnpm probe:node-anatomy`)     |
| `nodeguide/appendix.test.ts`        | the node guide's static crawler index: coverage, demo links, anchors, escaping                       |
| `nodeguide/nodeGuide.test.ts`       | the node guide's data: paragraphs, socket styles, params, examples                                   |
| `overview/overview.test.ts`         | the overview page against the registry: node count floor, backends and families named                |
| `packguide/render.test.ts`          | the pack guides' renderer and each guide held to the registry                                        |
| `vite/shortcutPages.test.ts`        | (repo root) a shortcut's redirect page: shortcut named, fragment carried, `noindex`                  |
| `vite/stripComments.test.ts`        | (repo root) `stripHtmlComments`' four silent cases                                                   |
