# Coda — notes for AI sessions

Browser-based node-graph editor for connectome analysis. Prototype stage. See
[README.md](README.md) for the user-facing picture and
[docs/adding-a-node.md](docs/adding-a-node.md) for the main extension point.

## Commands

```bash
pnpm dev            # vite dev server
pnpm test           # vitest
pnpm test:watch
pnpm typecheck      # tsc -b --noEmit
pnpm lint           # eslint, includes the core/UI boundary rule
pnpm build          # tsc -b && vite build
```

Node is at `/opt/homebrew/bin/node` (Node 26, installed via brew). Node 25+ dropped
bundled corepack, so pnpm was installed with `npm i -g pnpm`.

## Invariants — don't break these silently

Rules only. Each was written after it was violated; the incident is what makes the rule
arguable-with rather than arbitrary, and [docs/invariants.md](docs/invariants.md) has it in
full. **Read it before deciding a rule does not apply to your case.**

1. **`src/core` and `src/data` are headless.** No React, no zustand, no store, no UI
   imports. Enforced by a lint rule in `eslint.config.js`. The reason is a future
   non-React consumer, plus DOM-free unit tests.

2. **`inferOutputs` must never throw and must not fetch.** It runs on every graph
   mutation; failures degrade to "unknown type", which silently kills column pickers.
   Because it reads whatever is cached, something has to say when a degraded answer is
   worth redoing: fire `reportSourceLearned` for anything inference reads synchronously.

3. **Schema half and value half must agree.** Every op in `src/nodes/lib/tableOps.ts`
   has a `*Schema` and a `*Table` function side by side. If they disagree, downstream
   column pickers break only after a run.

4. **Cache keys are provenance, not content** — `hash(type, params, upstream keys)`. So
   `evaluate` must be deterministic; hidden mutable state needs an explicit nonce param.
   `normalizeParams` excludes hidden (`visibleIf` false) and `presentational: true`
   params. Mark a param presentational **only** if it cannot change what `evaluate`
   returns — getting it wrong means a stale result silently survives an edit.

5. **Resolve column params via `ctx.column()` / `ctx.columns()`,** never
   `ctx.params.someColumn`. Infer, validate, evaluate and the cache key all rely on the
   same resolution. Corollary: **an unresolved column is not grounds for `evaluate` to
   throw** — a viewer that passes its input through has no business blocking everything
   downstream because a picker is unset.

6. **`cheap` vs `expensive` on a node is a real decision.** `cheap` re-runs
   automatically on every edit, so a backend call marked `cheap` fires a request per
   keystroke at a shared production server.

7. **Selectors must not allocate.** The store is read through `useSyncExternalStore`,
   which compares snapshots by identity. Select primitives, or memoise.

8. **A neuron id crosses the `DataSource` seam as text, never as a number.** `CellValue`
   is a float64, so an 18-digit CAVE root id parses to a *different neuron* with nothing
   to say so. The rules are one definition each in `src/core/ids.ts` — `NeuronId`,
   `isNeuronId`, `idText` (cell → id), `compareIds` (length-then-lexicographic),
   `numericId`, `ID_COLUMN_NAME` — and there is deliberately **no re-export**, because a
   shim is how a symbol acquires a second spelling. Each source converts at its own edge;
   each backend maps its own id column onto `neuronId` at its own seam. Geometry carries
   the id as plain `id`, as a draw/export key rather than the identity. The UI is where
   this keeps being re-broken: never `Number(...)` an id.

## Gotchas found the hard way

Rules only; [docs/gotchas.md](docs/gotchas.md) has the incident behind each and the
symptom to recognise — which usually points nowhere near the cause. Where a rule belongs
to one area, its record is in that area's doc, linked inline. **A rule here is a summary of
a measurement; the doc is where the measurement is.** Read the doc before deciding a rule
does not apply.

Cross-cutting — these bite in code that is not obviously "about" the area:

- **A column picker keeps a chosen column rather than substituting.** A schema without a
  column is very often a schema that has not *arrived*. Substituting cost 9 GB once.
- **A picker on its own declared default still resolves before the schema lands**, and an
  unset *required* picker means its declared default. On an `optional` picker, empty is a
  decision and stays one. **A multi-column picker keeps an unseen list untouched.**
- **Both peeks start the fetch they cannot answer** (`peekDatasets`, `schemasFor`), once
  per instance. Otherwise the first Run of a session behaves differently from the second.
- **A node whose output size is the product of two independently-resolved columns needs a
  ceiling checked before allocation** — neither picker knows what the other did.
- **A guard rail warns; it does not refuse.** A refusal claims there is no useful answer,
  which for a count is almost never true. `ctx.warn` is the channel; `CRASH_FLOOR_BYTES` is
  the only thing left that refuses, and only for an allocation. Time is never a refusal.
  See [docs/limits.md](docs/limits.md).
- **A param added to a node type that already exists has three states, and a card can only
  draw two.** `defaultParams` writes a default in at *creation* and never runs over
  `deserializeGraph`, so a stored node without the key was written by a build that had no
  such control — which is not the same as the default, the moment absence means something
  *else*. `ParamBase.absentMeans` records the third state and `deserializeGraph` writes it
  in on load; deliberately not a general backfill. Other half of the trap: **a node with a
  body of its own draws no generic param rows**, and `compact` is always true for an
  on-canvas card, so gating on `!compact` means "inspector only".
  See [docs/datasets.md](docs/datasets.md).
- **Module init order.** `graphStore.ts` imports `../nodes` for its side effect; a Node-side
  script needs `registerBuiltinSources()` too, or every dataset node reports "Data source is
  not registered". Both failures are total and both read as a data problem.
  `src/data/builtins.ts` is the one set.
- **Whole-string patterns are anchored, in one place.** `anchoredPattern` (`data/terms.ts`)
  wraps them in `^(?:…)$` to match Neo4j's `=~`, so `LC.*` matches `LC4` but **not** `LPLC1`.
  Every builder goes through it. Don't "fix" this.
- **One `fetchText`, in `src/data/fetchText.ts`.** A cross-origin GET that has to tell
  "unreachable" from "CORS refused" is that function. Copied twice already; don't.
- **`parseMarkdown`'s extended kinds are opt-in, and that is a safety property.** Fences,
  callouts, tables and images parse only under `{ extended: true }`. A dataset blurb arrives
  from whatever deployment a Custom node points at; an image in one is a tracking pixel, and
  a fence is a directive some renderer may act on. Only `src/help` opts in.
- **A generated file that is committed must not carry a wall clock.** `ZooIndex.updatedAt` is
  the newest entry's commit date, not `Date.now()`, so `zoo-index --check` can byte-compare it.
- **A buffer handed to `callPython` is detached the moment the call is posted**, so read
  anything about it — its length above all — *before* the await.
- **`localStorage` is undefined** under Node 26 + jsdom. Tests use `clearStorage()` /
  `installStorageStub()` from `src/test/jsdomStubs.ts`.
- **React Flow needs measurements.** In jsdom, unmeasured nodes are `visibility: hidden`, so
  component tests pass `{ hidden: true }`. `installJsdomStubs()` supplies ResizeObserver,
  `getBoundingClientRect`, `matchMedia` and a 2D canvas context. WebGL stays absent on purpose.
- **`erasableSyntaxOnly` is on**, so no TS parameter properties (`constructor(private x)`).

Area-specific — the rule, then the doc that holds why:

- **`defaultSize` sizes React Flow's _wrapper_, and only a viewer's card fills one**
  (`category: 'visualisation'`). Elsewhere it leaves the state bar hanging below the card. A
  node that only wants to be wider sets `NODE_BODIES[type].width`.
- **Two wires between the same pair of nodes are not a cycle.** `topoSort` derives indegree
  from the same index that decrements it, so the two cannot disagree again.
- **A group frame is not a React Flow node**, and three viewport properties keep it honest:
  `ViewportPortal` at `z-index: -1`, `pointer-events: stroke` on the rect alone (the interior
  must stay click-through), and `nopan`, because panning is d3-zoom's *native* listener and
  `stopPropagation` cannot reach it. Membership is a list of node ids and the box is derived —
  `parentId` would re-base every child's `position`, which five subsystems read absolutely.
  See [docs/canvas.md](docs/canvas.md).
- **`overflow-y: auto` clips the other axis too**, so a `Dropdown` holding a flyout submenu
  must pass `flyouts` to switch the panel's scroll off, or the submenu renders as a horizontal
  scrollbar. And **a shortcut's glyph is stored by meaning, not as text** — `src/ui/shortcuts.ts`
  is the one table, `formatChord` the only place that knows ⌘ from Ctrl, and four surfaces read
  it. `Editor.tsx` still owns the *bindings*. See [docs/ui-shell.md](docs/ui-shell.md).
- **A loop is one number in a hash, and the region is derived from the wires.** `For Each` has
  no sub-graph: `Scheduler.loopIndex` is folded into the begin node's provenance key, so
  advancing it re-keys every descendant and invariant 4 re-runs the region. Hence: the loop
  executes at the **last** node of its region; a settled loop does not re-run, so the index is
  left at `count - 1` rather than reset, while a **cancelled** loop needs `loopDone` to stop it
  settling half-processed; a `Collect` is the one node a cache hit must never answer for
  mid-pass; and `RunSummary.executed` is a set of node ids, so per-pass files come through the
  awaited `SchedulerHost.onIteration`, bounded by `loopNodes`. See [docs/loops.md](docs/loops.md).
- **A dataset-level filter is not a filter row, the row wins, and the filters OR.** The
  population checkboxes on a neuPrint dataset node are **OR-ed** — a second ticked box lets
  *more* rows through. `typed` matches column names **ending** in `type`. `findNeuronsCypher`
  drops the `traced` disjunct when a filter row names `status`, and all four emitter spellings
  repeat that. Defaults are per **family**. Which queries they reach is `neuronSetRequest`, kept
  separate from `datasetRequest`: never a lookup by id, never the far end of a `ConnectsTo`. The
  neuron index is cached whole and narrowed on load. And a schema that has not arrived is not a
  schema without these columns — compare `discoveredNeuronSchema` by **identity** before greying
  a box. See [docs/datasets.md](docs/datasets.md).
- **An edge list is not a skeleton.** `SkeletonGeometry.parents` is a rooted tree in *visit
  order*, built from an undirected graph that may hold cycles and disconnected components.
  `spanningForest` (`src/data/skeletonTree.ts`) is the one walk; a surviving cycle makes every
  consumer that walks to a root loop forever. See [docs/backends.md](docs/backends.md).
- **Two ways a mesh source resolves to somewhere with no meshes in it**, both reported as
  neurons that have none. `@type` is optional on a precomputed volume, so `isVolumeInfo` — not a
  `switch` on `@type` — is the one predicate `openMeshSource` and `probe.ts` ask. And a graphene
  manifest is not all shards: it mixes shard reads with plain objects under
  `mesh_metadata.unsharded_mesh_dir`, so the neuron arrives whole minus every piece anyone has
  edited. `fragmentUrl` matches on `.shard:`. See [docs/backends.md](docs/backends.md).
- **CAVE's row cap is a per-deployment number, and a reference table has no root id.**
  `CAVE_MAX_ROWS` is one server's `QUERY_LIMIT_SIZE`, so truncation is tested against the
  server's own `COUNT` (`countTable`), never the constant and never with `>=`. A
  `cell_type_reference` table carries `target_id` and no root id: reading one means the *join*
  endpoint, which takes `select_column_map` and only that, and ignores `count=true`. Both
  failures read as facts about the data. See [docs/backends.md](docs/backends.md).
- **A thumbnail is not always a mesh.** `CoarseGeometry` is a union and `kind` is required on
  both arms — a source that omits it silently falls through to the mesh branch and draws a blank
  tile. CATMAID skeletons carry no byte ceiling on purpose, and both rasterisers in
  `src/ui/explore/thumbnail.ts` share one `fitToTile`. See [docs/widgets.md](docs/widgets.md).
- **The fat-line path is four shader patch sites that must agree, and a patch that stops
  matching is silent.** `SkeletonGeometry.radii` is filled by all three skeleton backends;
  three's `LineMaterial` takes one `linewidth` uniform, so `flexLineMaterial.ts` rewrites
  three's own shaders — vertex *and* fragment for the world-unit (`to scale`) mode, or the box
  and its silhouette disagree. It **throws rather than falling back**, because a `ShaderLib`
  rename compiles fine and draws every skeleton at the uniform width;
  `flexLineMaterial.test.ts` runs the patch. Three numbers are load-bearing: scale against the
  **p95** radius, never the maximum; keep the 1px floor (`MIN_WORLD_PIXELS` per vertex via
  `abs( clip.w )`, since a floor cannot be a number of nanometres); and three's
  `rayEnd … * 1e5` is exactly 100 µm in a nanometre scene, past which *every fragment discards*
  and the arbour vanishes whole in one zoom step. See [docs/viewers.md](docs/viewers.md).
- **A post-processing pass moves the background out from under the scene, twice.** An
  `EffectComposer` renders into a texture, so the canvas colour needs `scene.background` (not
  the clear colour, which `RenderPass` sets before binding the target) and `<Canvas flat>` (tone
  mapping is per-*image* through a composer, not per-material). Four more seams it owns:
  `setSize` takes **CSS pixels**; the PNG export renders its own frame and must go through the
  chain; `_overrideVisibility` misses fat lines (a `Mesh` carrying `isLineSegments2`), which is
  what `hidesFromGtao` is for; and **both** world-unit uniforms are rescaled, `radius` *and*
  `thickness` — a library's world-unit defaults agree with each other, so rescaling one is a
  different kind of broken rather than a partial fix. Strength is one slider where 0 is off, not
  a toggle plus a strength. And **a `useMemo` may be reused across a remount while an effect
  cleanup always runs**, so return the pass from the memo rather than writing it into a ref.
  Render an effect's own buffer before explaining why it looks weak, and measure on a real GPU —
  headless Chrome falls back to SwiftShader. See [docs/viewers.md](docs/viewers.md).

## Chart colours

Do not pick chart colours by eye. The palette in `src/ui/colors.ts` was validated with the
`dataviz` skill's validator; the header comment records what passed and what didn't. If you
change the palette, re-run the validator; don't reason about ΔE.

The load-bearing finding: **only three chromatic families clear the all-pairs
colourblind-safety gate on the dark surface**, which is why socket types are distinguished
by colour _plus shape plus a visible label_. A fourth socket hue from these ramps fails the
normal-vision floor.

`CHART_INK.grid` is for chrome only — under the 3:1 non-text floor, i.e. invisible by design.
Anything carrying data (network links, and their arrowheads) takes `muted` instead, which is
achromatic so it never competes with a categorical encoding.

## The rest, by area

Each is a design record: what was tried, what was measured, which failures are silent.
**Read the one for the area you are about to change** — most entries exist because the
obvious approach was wrong. Ordinary links, deliberately not `@`-imports: `@docs/foo.md`
in a CLAUDE.md *imports* the file, pulling all 1.2 MB back into every session.

- [docs/adding-a-node.md](docs/adding-a-node.md) — the main extension point. Start here for
  any new node.
- [docs/testing-layers.md](docs/testing-layers.md) — which test file covers what. Check
  before writing a test, and where a new one belongs.
- [docs/invariants.md](docs/invariants.md) / [docs/gotchas.md](docs/gotchas.md) — the
  incident behind each rule above.
- [docs/limits.md](docs/limits.md) — every guard rail, its tier, and the `ctx.warn` channel.
  Read before adding a number that stops somebody.
- [docs/core.md](docs/core.md) — the two caches and `ctx.refresh`, auto-run, reference edges.
  Read when adding `dataCache` or a `reference` port.
- [docs/canvas.md](docs/canvas.md) — React Flow settings, ELK layout, edge routing,
  collapse/fold/resize, splice-onto-wire, rewiring links, fit-on-load.
- [docs/loops.md](docs/loops.md) — `For Each` and `Collect`: the region, the `onIteration`
  seam, the two routes a loop's files take.
- [docs/viewers.md](docs/viewers.md) — every `out.*` widget, the shared export path,
  encodings, tooltips, table filtering, number formatting, the styling sidebar, the 3D path.
- [docs/widgets.md](docs/widgets.md) — Explore Dataset, Neuron Profile, Dataset Summary, ROI
  Viewer: the surfaces that fetch for themselves rather than reading a wire.
- [docs/nodes.md](docs/nodes.md) — per-node semantics: Pivot, Deduplicate, both import nodes,
  Combine Columns, Select One, Stack, Download, Connectivity, Paths, both id nodes, Text notes.
- [docs/datasets.md](docs/datasets.md) — the family table, Custom backend nodes, the
  Description companion, auto-wiring, starter graphs. Also **datasource vs dataset**: a
  Neuroglancer Source emits a `Dataset` so the geometry nodes take it, and
  `SourceCapabilities` is the only thing keeping that honest.
- [docs/backends.md](docs/backends.md) — neuPrint, CAVE, CATMAID, precomputed. Read the
  relevant one before touching anything under `src/data`. `precomputedToHttp` is deliberately
  narrower than the source parser beside it, for a measured reason; don't widen it.
- [docs/comparative.md](docs/comparative.md) — comparative connectomics: the cell-type
  correspondence graph, type-level edge comparison, neuron-level co-clustering (the one piece
  still unbuilt). Read before adding any node that puts two connectomes in one table — the
  qualified-id decision is recorded there.
- [docs/annotations.md](docs/annotations.md) — labels that do not come from the connectome:
  the Annotations socket, SeaTable, Google Sheets, root-id drift.
- [docs/export.md](docs/export.md) — the notebook and R Markdown exporters, the refusal
  policy, the emitter registry, the goldens.
- [docs/python-pyodide.md](docs/python-pyodide.md) — the Pyodide bridge and the six
  capabilities on it. Read before adding a Python-backed one: all six declare the same two
  packages, which is the finding rather than a coincidence.
- [docs/persistence.md](docs/persistence.md) — share links, the autosave across tabs, the
  browser shelf.
- [docs/zoo.md](docs/zoo.md) — the Coda Zoo, and why its index is a committed file rather
  than an API listing. Read before changing `ZooIndex`.
- [docs/ui-shell.md](docs/ui-shell.md) — panels, fullscreen and the manifest, the run
  indicator, the start page, keyboard shortcuts.
- [docs/pages.md](docs/pages.md) — overview, tutorial and node guide. Extra vite entries;
  each must stay out of the main chunk.
- [docs/help.md](docs/help.md) — the `?` on a node: the in-app overlay, the documents in
  `src/help/nodes/`, and the figures that draw real registry objects.

Two notes cut across all of them. **jsdom performs no layout and has no WebGL**, so anything
about geometry or pixels must be driven in a real browser. And **every measurement here was
taken, not estimated** — re-measure rather than reasoning one forward.
