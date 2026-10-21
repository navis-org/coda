# Coda — notes for AI sessions

Browser-based node-graph editor for connectome analysis. Prototype stage. See
[README.md](README.md) for the user-facing picture and
[docs/adding-a-node.md](docs/adding-a-node.md) for the main extension point.

**This file is rules only.** Every rule here was written after it was violated, and the
incident, the measurement and the symptom live in the area doc named beside it. A rule here is
a *summary of a measurement*; the doc is where the measurement is. **Read the area doc before
deciding a rule does not apply to your case** — most of these exist because the obvious
approach was wrong. Nothing belongs here that a single area doc can hold: this file is loaded
into every session, so prose added here is paid for on every turn.

## Commands

```bash
pnpm dev            # vite dev server
pnpm test           # vitest
pnpm test:watch
pnpm typecheck      # tsc -b --noEmit
pnpm lint           # eslint, includes the core/UI boundary rule
pnpm knip:check     # dead code against knip-baseline.txt; knip:update to accept a change
pnpm format         # prettier, over src/**/*.{ts,tsx,css} and nothing else
pnpm build          # tsc -b && vite build
```

Node is at `/opt/homebrew/bin/node` (Node 26, installed via brew). Node 25+ dropped
bundled corepack, so pnpm was installed with `npm i -g pnpm`.

## Invariants — don't break these silently

[docs/invariants.md](docs/invariants.md) has the incident behind each in full.
**Read it before deciding a rule does not apply to your case.**

1. **The headless areas — `src/core`, `src/data`, `src/nodes`, `src/style` and the rest listed in
   `eslint.config.js` — import no React, zustand, store or UI**, nor does `nodes/lib` import
   `src/style`. Enforced per file by lint and, transitively and for every Web Worker, by
   `src/test/importGraph.test.ts`. (Non-React consumers — the MCP server — and DOM-free tests.)

2. **`inferOutputs` must never throw and must not fetch.** It runs on every graph mutation;
   failures degrade to "unknown type", which silently kills column pickers. Fire
   `reportSourceLearned` for anything inference reads synchronously from a cache.

3. **Schema half and value half must agree, and sit side by side.** Every op that shapes its output
   has an adjacent `*Schema`/`*Table` pair (row-only ops pass the schema through) plus an agreement
   test — usually `src/nodes/lib/tableOps.ts`, or a focused sibling with its own sweep
   (`matrixReduce.ts`). `tableOps.test.ts` is per op, so a pair nobody adds a case for is unchecked.

4. **Cache keys are provenance, not content** — `hash(type, params, upstream keys)`: `evaluate` is
   deterministic, hidden mutable state takes an explicit nonce param. `normalizeParams` drops hidden
   (`visibleIf` false) and `presentational: true` params — presentational **only** if it cannot
   change what `evaluate` returns. Read `ctx.params.x` plainly (`withDefaults`; no `?? literal`) and
   ask `visibleIf` through `visibleParams`.

5. **Resolve column params via `ctx.column()` / `ctx.columns()`,** never `ctx.params.someColumn` —
   infer, validate, evaluate and the key share that resolution. **An unresolved column is not
   grounds for `evaluate` to throw**; a pass-through viewer must not block everything downstream.

6. **`cheap` vs `expensive` on a node is a real decision.** `cheap` re-runs on every edit, so a
   backend call marked `cheap` fires a request per keystroke at a shared production server.

7. **Selectors must not allocate.** `useSyncExternalStore` compares snapshots by identity. Select
   primitives, or memoise.

8. **A neuron id is text everywhere — across the `DataSource` seam and in every published column —
   and every source publishes one id dtype, `str`.** A float64 `CellValue` turns an 18-digit root
   id into a different neuron silently; never `Number(...)` an id. One definition each in
   `src/core/ids.ts` (`NeuronId`, `isNeuronId`, `idText`, `compareIds`, `numericId`,
   `ID_COLUMN_NAME`, `isIdentifierColumn`), **no re-export**; geometry's plain `id` is a draw key.
   `isSegmentId` is a second predicate (neuroglancer's narrower grammar), not a second spelling.

## Gotchas found the hard way

The rule, then the doc that holds the incident, the measurement and the symptom — which usually
points nowhere near the cause. [docs/gotchas.md](docs/gotchas.md) is the general record; where a
rule belongs to one area, its record is in that area's doc.

### Cross-cutting — these bite in code that is not obviously "about" the area

- **A column picker keeps a chosen column rather than substituting** — a schema without the column
  has usually not *arrived* yet. An unset *required* picker means its declared default, and a
  picker on its default resolves before the schema lands; on an `optional` picker empty is a
  decision. **A multi-column picker keeps an unseen list untouched.**
- **Both peeks (`peekDatasets`, `schemasFor`) start the fetch they cannot answer**, once per
  instance. **A peek needing a credential is gated on one** (`PeekGate`), re-armed when it
  *changes*; a new peek joins `src/data/peeks.test.ts`'s list. See
  [docs/backends-cave.md](docs/backends-cave.md).
- **Output sized by the product of two independently-resolved columns needs a ceiling checked
  before allocation** — neither picker knows what the other did.
- **A guard rail warns; it does not refuse** (`ctx.warn`). Only `CRASH_FLOOR_BYTES` refuses, and
  only an allocation; time never does. State a limit in the units of what it protects. See
  [docs/limits.md](docs/limits.md).
- **Renaming a port, param or type loses saved state in silence unless declared:**
  `PortGroupDef.formerIds`, `ParamBase.formerId`, `NodeDefinition.formerTypes`, read only after the
  live id misses — never a migration table in the loader. A param *added* later has a third state,
  "absent": `ParamBase.absentMeans` (`defaultParams` never runs on load). See
  [docs/nodes-tables.md](docs/nodes-tables.md), [docs/packs.md](docs/packs.md).
- **A node with a body of its own draws no generic param rows, and `compact` is always true on a
  canvas card**, so gating on `!compact` means "inspector only". See
  [docs/datasets.md](docs/datasets.md).
- **An unknown node type loads as a `core.missing` placeholder and is written back as itself.**
  Every writer of graph JSON goes through `graphText` (→ `documentNode`). Registered definitions are
  **frozen**; type ids follow `core/nodeType.ts` (`pack:name`). See
  [docs/persistence.md](docs/persistence.md).
- **A pack switched off hides, never unregisters.** Offer nodes via `useOfferedNodeDefsByCategory`
  / `useOfferedForNewWork`, never the registry directly (passes every test, ignores the switches).
  Which pack a node is from is `packOfType`, never the id. See [docs/packs.md](docs/packs.md).
- **Module init order:** `graphStore.ts` imports `../nodes` for its side effect, and a Node-side
  script also needs `registerBuiltinSources()` (`src/data/builtins.ts`), or every dataset node
  reports "Data source is not registered" — which reads as a data problem.
- **Whole-string patterns are anchored, in one place** — `anchoredPattern` (`data/terms.ts`),
  matching Neo4j's `=~`: `LC.*` matches `LC4`, not `LPLC1`. Don't "fix" this.
- **One `fetchText` (`src/data/fetchText.ts`)** for any credential-less cross-origin read that must
  tell unreachable from CORS-refused (GET, or POST via `init`). Don't copy it.
- **`parseMarkdown`'s extended kinds (`{ extended: true }`) are opt-in as a safety property** —
  only `src/help` opts in; a dataset blurb's image is a tracking pixel. See
  [docs/help.md](docs/help.md).
- **Analytics sends a literal path and has two gates:** `apply: 'build'` **and** `CODA_ANALYTICS`
  (set only in `deploy.yml`), so a fork never reports its readers. Pinning the path does not stop
  `count.js` sending `q`/`t`. No event tracking. See [docs/analytics.md](docs/analytics.md).
- **Crawlers do not run the script:** `index.html` carries a `<noscript>` hero (never markup in
  `#root`), `nodes.html` a **visible** static index (hidden text is cloaking). `lastmod` is git's or
  absent, never a wall clock; `SITE_URL` is deliberately ungated. See [docs/seo.md](docs/seo.md).
- **A committed generated file carries no wall clock** (`ZooIndex.updatedAt` is a commit date), so
  `zoo-index --check` can byte-compare it.
- **A buffer handed to `callPython` is detached once posted** — read its length before the await.
- **jsdom:** `localStorage` is undefined under Node 26 (`clearStorage()` / `installStorageStub()`);
  React Flow hides unmeasured nodes (pass `{ hidden: true }`); without `installJsdomStubs()` a
  pointer event arrives as a bare `Event` and `setPointerCapture` throws, which reads as "the
  handler never ran". WebGL stays absent on purpose; geometry is the browser probes'.
- **`erasableSyntaxOnly` is on**, so no TS parameter properties (`constructor(private x)`).
- **Prettier owns `src/**/*.{ts,tsx,css}` and nothing else** — `pnpm format` is the one scope; never
  `prettier --write .` (it rewrites `*em*` in every `.md`). CI runs `pnpm format` + `git diff
  --exit-code`, deliberately not a second `--check` script.
- **A table file (`tableFile`) is a reference only a reader may take**, never assignable to `table`.
  Filter Table alone defers (its condition rides on the file; row-local only). A Delta table is read
  through its log, never listed; hyparquet is **patched** (`patches/`, dropped silently on upgrade);
  a keyed Parquet read (`pages.ts`) refuses (`Unsupported`) anything it cannot read exactly. See
  [docs/nodes-io.md](docs/nodes-io.md).
- **A long-lived closure keeps its whole creating scope alive** (one V8 context per scope), so a
  loader or tree kept past its build is made in a function holding only what it reads. See
  [docs/datasets.md](docs/datasets.md) and the distances rule below.

### Canvas, cards and layout — [docs/canvas.md](docs/canvas.md)

- **A node's glyph is one drawing per type in `ui/glyphs.ts`, kept as data (primitives, not JSX)
  because `nodes.html` draws it with no React.** `currentColor` only. Silent, pinned by
  `glyphs.test.ts`: a mistyped key serves the category fallback; scaling a silhouette scales its
  stroke; the two renderers can disagree on `strokeWidth` vs `stroke-width`.
- **Every button in the canvas **+** is derived** (`nodeDefsByCategory`, `glyphs.ts`), never a second
  table. A closed surface is **unmounted, not hidden** (jsdom cannot tell); the prefix is `fab-menu`
  (`add-menu` is the palette's); `data-tour="add"` sits on the stack, not the button.
- **A card the layout must not place is condensed, never constrained** (`layout/companions.ts`; a
  chain caption too): withheld from ELK with its **host's box grown to cover it** — the silent half —
  as an overlay on the measurement map, then snapped under the host's measured height.
- **`arrangeScope` withholds every reference edge, and `condense` must take the same `omit` set**, or
  `collapsedView` re-merges the wire from `graph.edges` the moment an end is folded
  (`CollapsedEdge.merged`). Excluded, never reversed.
- **Column packing is a post-pass on ELK (`layout/pack.ts`), not a fifth algorithm.** Its objective
  is **one-sided** (only too-tall scores); a card joins a *predecessor's* column at its bottom; ELK's
  within-column order is kept; `packApplies` gates it. Routes are dropped on the returned `moved`,
  never on map identity.
- **`defaultSize` sizes React Flow's _wrapper_, and only a viewer's card fills one**
  (`category: 'visualisation'`); elsewhere the state bar hangs below the card. A node that only wants
  to be wider sets `NodeDefinition.cardWidth`. See [docs/gotchas.md](docs/gotchas.md).
- **Copy/cut/paste ride the clipboard *events*, and a paste that is not a graph falls through** —
  `readFragment` runs *before* `preventDefault`. `duplicateSelection` is the same `subgraphOf` +
  `insertFragment` pair. Copy is live under the lock; cut and paste are not.
- **An output socket's hover preview is silent where nothing has run** — it may neither fetch nor
  run (invariant 6), and there is no inferred-schema fallback. It is `useHoverPanel` (shared with
  `NeuronThumbnail`); the headline is `describeValue`'s line, never a second spelling of it.
- **A hint (`NodeHint`) is a field on `GraphNode`, drawn as a sibling of `.coda-node`, and dismissing
  it is `localStorage` keyed on its text — never an edit.** Writing one is an edit, live under the
  lock. A sentence true of the reader's *browser* is derived (`NodeDefinition.readerHints`), never
  written. See also [docs/wizard.md](docs/wizard.md).
- **An expanded group frame is not a React Flow node (`ViewportPortal`, no `parentId`); a folded one
  is, minted per render.** `collapsedView` is one derivation read by the canvas *and* the ELK pass;
  exposed params are a reference, never a copy. Browser-only traps: all-false flags withhold the
  pointer, the selection rectangle sits over the cards (taking their events) and includes hidden nodes, and measurement scopes to `.canvas-area`.
- **Two wires between the same pair of nodes are not a cycle.** `topoSort` derives indegree from the
  same index that decrements it. See [docs/gotchas.md](docs/gotchas.md).

### Ports, params and node semantics — [docs/nodes.md](docs/nodes.md) and its family files

- **A port typed `T.any()` declares what it really takes in `PortDef.kinds`** — the very array its
  `validate` predicate reads, listed as kinds *arrive* (before `isAssignable`'s widening). A bare
  `any` stays unresolved and never refuses; a declared set does refuse. A real `any` says
  `anyKind: true`. Read sockets through `resolvedSocket`, never `resolved ?? declared` (inference is
  seeded with `T.any()`). `Geometries` is a label, not a `CodaType`. See
  [docs/adding-a-node.md](docs/adding-a-node.md) and [docs/canvas-interaction.md](docs/canvas-interaction.md).
- **Advice about one producer's columns goes on that producer's port (`PortDef.feeds`), never in a
  general consumer's description** — and a port declaring one reading of a request must declare the
  other. See [docs/assistant.md](docs/assistant.md).
- **Optional inputs compose unless `PortDef.exclusiveGroup` says they are alternatives** — read by
  every automatic wiring pass. A declaration, not a canvas constraint: `validate` names the port to
  disconnect.
- **`Find Neurons` asking nothing answers nothing — decided at the node (`asksNothing`), never at the
  seam**, where empty `rows` still means no narrowing. `In ROI` counts as asking, `Limit` does not;
  the empty table carries the dataset's own neuron schema.
- **`whenWired` hides a param while its socket is unwired, on the card and inspector only — never in
  a node body** (`paramFold.test.tsx`). Display only; it stays in the provenance key. See
  [docs/adding-a-node.md](docs/adding-a-node.md).
- **A neuPrint dataset's population checkboxes are OR-ed, not filter rows, and a `status` row wins**
  (`findNeuronsCypher` drops `traced`; all four emitters repeat it). They reach only
  `neuronSetRequest`. Compare `discoveredNeuronSchema` by identity before greying a box. See
  [docs/datasets.md](docs/datasets.md).
- **A split is one pass (`Split Neurons`, `partitionElements`), never two opposite filters**, which
  silently drop rows from both arms. Bounds recomputed, `units`/`space`/`provenance`/`detail`
  carried; no rows sends everything to `Rest`.
- **A geometry's attribute table is the source's morphology schema, not the neuron table; `Carry
  fields` bridges it with `core.join`'s join** (shared with `neuron.attachAttributes`, not copied). A
  carried column keeps the old one's slot (`foldNodeColumns`); keys never carried (`carryable`);
  `onPartial` carries too.
- **`Points in Volumes` is two ports *and* a column; overlap is counted, first in item order wins.**
  The minted column goes through `foldColumns`, whose guard asks about the incumbent.
- **A long loop in `evaluate` is `core/slice.ts`' `sliced` — share the loop, not `yieldToBrowser`.**
  `evaluate` is on the main thread, so a loop that never yields cannot see Cancel; the clock stride
  adapts from one.
- **A distance between neurons is weighted by material** (half-edge length per skeleton node, a third
  of triangle area per vertex), measured to the target's surface, over nearest-point distances only.
  Index is a k-d tree, not `topologyOps`' grid; `closestPairApplies` is the one predicate; Cancel only
  via `sliced`. Refusals render through `mixedQuantityRefusal`. See
  [docs/limits.md](docs/limits.md).
- **`Synapses to Edges` must be told which end is presynaptic (`Orientation`)** — `polarity` is the
  drawn end on one cloud and the neuron's role on another. A cell neither `pre` nor `post` is not
  flipped; a weight is a row count, never a sum. `edgePlanRefusal` is one sentence for four surfaces.
- **`Synapses`' threshold is `Min confidence` (default 0, no `max`), and `Rows` says what a row
  counts** — `skeletonParams.ts`' shape, a pinned unit the source lacks an error, never a
  substitution. `SynapseRequest.unit` is resolved once, at the node. A lone unit is not listed, so a
  graph pinned to it hits the "chosen but unlisted" branch.

- **A synaptic partner is usually not a neuron, so an edge-list node says which it meant.**
  `Include fragments` is a `findNeurons` lookup per hop, never a clause compiled into the backends;
  seeds are exempt; it bounds the frontier, not just the rows (`absentMeans: true`). Under full
  metadata the `Neuron Set` port is a **left join**.
- **A normalised weight is meaningless without its denominator (`weightTotal`), and there are two.**
  Outgoing is **`downstream`, never `pre`**; the totals query matches `:Segment` on the queried end;
  a missing or zero denominator is **null and counted**, never 0. `minWeight` applies **before** any
  region split, so turning the split on cannot change which partners are found.
- **A split reads each region's own share of an edge property, never the connection's value** (that
  gets summed again downstream): absent is 0 only where the breakdown names the property, else null.
  `DatasetInfo.edgeProperties` is sampled; `perRegion` labels the picker and the query ignores it.
- **A path's denominator belongs to a population, and `Min fraction` prunes per hop.**
  `fetchGroupTotals`/`canTotalGroups`, its type arm `:Neuron` (numerator's population). `Rank by`'s
  bound, neighbour order and shortlist read the metric through **one** function. An unmeasured
  connection is never dropped and never scored; Paths has `bottleneckNorm` and no denominator column.
- **Influence's `Transfers` port keeps what `propagate` already computed — no fetch.** Ribbons are
  grouped **inside** the walk (`ribbons` enum, untyped → one bucket); a band runs pre→post, flipping
  with `Direction`; `layer` is a drawing position, not the hop count; the shortfall is left to the
  geometry, reasons via `ctx.warn`. The removed `Network` port is dropped on load, **not `formerIds`**.
- **A bounded influence score is the published one truncated** — a strict lower bound, so each loss
  is a number. Default gain is **0.5, not 0.99**. It is **not a BFS**: fetch once, propagate from
  every hop. Meeting in the middle buys fetch count, not depth, and reports no truncation bound.
- **A per-seed channel is indexed by position, so the node deduplicates seeds first.** Test with an
  **interleaved** repeat; a set stacked onto itself is already aligned and hides the bug.
- **`Reduce Matrix`'s axis names the axis that *survives*** (`MatrixAxis`, shared with
  `matrixShape.ts`); the wrong reading is a silently transposed answer. Spread is **Welford's**.
  `Exclude diagonal` needs equal label lists — not `skip_self`. Key column `LABEL_COLUMN_NAME`.
- **An aggregation's null rule is one decision in three implementations** (canvas, pandas, R):
  `mean`/`min`/`max` of no number is **null**, `sum` is 0, `countDistinct` skips absences. R's
  `min`/`max` need `coda_min`/`coda_max` (`na.rm` gives `Inf`). Goldens compare text and cannot see it.
- **`Normalize` must not assume non-negative data.** A line of zeroes stays zero; a line holding
  values that totals ≤ 0 comes out empty and is counted. `max` is the largest *magnitude*.
- **Graph metrics are two nodes because `cost` is per type:** `net.metrics` `cheap`,
  `net.centrality` `expensive`. Self-loops count towards degree only (undirected simple projection);
  metric columns are written **over**; sampling never estimates a maximum. Warn from `evaluate`,
  never inside the memoised `networkMetrics` — the card may have primed it.
- **An embedding is a k-NN graph laid out**, in JavaScript (no numba in Pyodide). **`Seed` is what
  keeps invariant 4** without a nonce. Row `i` names itself first at distance 0; rows are exactly `k`,
  padded `-1` with the row's own furthest distance. Output keyed `label`. See
  [docs/python-pyodide.md](docs/python-pyodide.md).
- **The Heatmap's Order and Filter tabs are data, Colour is presentational.** The other axis follows
  by the **arrival** label, never index or drawn name. Clustering is seaborn's clustermap, not
  Linkage's (Pyodide in a `cheap` node, on purpose). Filters are one term per axis, `/` opts into a
  regex (`bareRegex`); an uncompilable pattern leaves the axis whole, a no-match is honoured.
- **A profile's grouped answer is the ungrouped one folded.** `Group by` is a presentational column
  picker resolved to member ids at pin time; reuse the single-neuron roll-ups per part, never
  reimplement them. Absent is a measured zero (`Aggregate.present`); above `MAX_AUTO_MEMBERS`
  deferred, not refused. See [docs/widgets-profile.md](docs/widgets-profile.md).

### Viewers — [docs/viewers.md](docs/viewers.md)

- **A heavy-tailed measure is a rank plot — dots on a log axis, with the running share of the total
  beneath, two panels sharing the rank axis and never two y-scales.** `rankSeries.ts` owns the
  refusals: a **signed** column withholds the share and leaves the ranking untouched; a flagged row
  is ranked and excluded from both halves; all-flagged is asked *before* all-zero.
- **A Sankey drawn on synapse counts does not conserve, so `out.sankey`'s caption measures it**
  (`conserves` / `18% stops`). The shortfall belongs to the *node*, never a notch at the column's
  foot (double-counts); exempt the last column and layer 0. A node is a (layer, label) pair; the
  within-column sweep is `barycentre.ts`, shared with the flow chart.
- **A 3D renderer is handed between surfaces, not rebuilt: `PersistentCanvas` keeps the root, never
  the viewer component**, under `scopedKey(workflowId, nodeId)`. Silent if broken: a portal owning
  the whole viewer loses React Flow's React-prop events, and a context bridge remounts the scene.
  The Neuroglancer iframe is kept the same way, only where `Element.moveBefore` exists.
- **A three.js vertex colour is linear light, so `hexToLinearRgb` linearises at the parse** — an
  sRGB triplet written into a `color` attribute is encoded twice. Meshes hide it; test a mid grey.
- **The fat-line path (`flexLineMaterial.ts`) patches three's shaders at sites that must agree, and
  throws rather than falling back** when a patch stops matching. World units patch vertex *and*
  fragment; scale against the **p95** radius; keep the 1px floor; three's `rayEnd … * 1e5` is
  100 µm in a nanometre scene.
- **An `EffectComposer` moves the background: use `scene.background`, not the clear colour, and
  `<Canvas flat>`.** Also: `setSize` takes CSS pixels; PNG export goes through the chain;
  `hidesFromGtao` for fat lines; rescale *every* world-unit uniform; return the pass from the
  `useMemo`, never a ref. Measure on a real GPU (headless Chrome is SwiftShader).
- **Shape folds where colour cycles:** `resolveShape` folds past six marks onto a **dash**. In
  `nodeShapeProgram.ts` sigma blends premultiplied, `MARK_EXTENT` is per shape, the shader flips
  `p.y`; the GLSL is generated from `markGeometry.ts`, and the module is dynamically imported.
- **`out.flowChart` is hand-rolled Sugiyama, not ELK, and has no `Layout` socket** — the layering
  is decided, back edges keep their direction, box sizes are measured text. The dummy nodes are
  load-bearing. The layer picker is `optional` (empty = longest path), never "prefer a `hop`
  column". Edge kinds differ by shape, never colour. The emitted R/Python is checked by running it
  (`pnpm probe:flowchart`); the drawing by `pnpm probe:flowchart-draw` *and* by eye. See also
  [docs/limits.md](docs/limits.md) (`FLOW_NODES_WARN`, `MAX_BOXES_DRAWN`).

- **A graph that is mostly not connected is laid out per component and the boxes packed — the
  force law does not fix it**, and that is the default. `prefuseRun` is resumable and sliced against
  the clock; its annealing state rides on the run, since restarting it per slice re-heats it and
  still draws something plausible. A separation test needs ≥ forty components or it passes without
  the feature; `componentLabels` must agree with `networkOps.connectedComponents`.
- **Colour by component and colour a link by its endpoint are modes, not columns** (`networkColor.ts`
  hands both to `resolveColor`). Components are undirected and numbered largest-first, to agree with
  `resolveColor`'s frequency ranking; an endpoint-coloured link reads the *resolved* node channel and
  draws no legend.
- **Network node dragging is five silent failures** (`networkDrag.ts`): `setCustomBBox` before a
  drag or `autoRescale` shrinks the graph away (⤢ clears it, in a `refresh`); `preventSigmaDefault`
  still lets a click through, so click handlers need their own tolerance; end on the captor's
  `mouseup`, not `upNode`. Positions are a delta from the grab, session-scoped via `layoutMemo`.
- **The network's right-click menu borrows rather than writes**: `NodeContextMenu`'s rows,
  `seedsFor` (shared with the drag), `net.filter`'s `expandSelection`. Results are in **node order**,
  as they land in a provenance-keyed `ids` param; the browser menu is cancelled on the *container*.
- **The heatmap's circles read the *bucket*, not the value**, so `colorDomain` stays the one mapping;
  area not radius, size is distance from `neutral` (continuous, `RAMP_STEPS` being even), a neutral
  cell draws nothing. `circlesFit` is a size test on the spec `&&`-ed with the param; the fallback
  note shows even under `compact`; exporters carry `shapeNote`.
- **One `colorDomain` decides a heatmap value's ramp position** — `normalize`, `bucketScale`, hit
  test and SVG export cannot disagree. A limit is a **`string` param** (0 is a real limit); a bad
  pair is dropped whole; diverging offers one end. The log is `log1p(v − lo) / log1p(span)`, on the
  colour alone — exporters keep the printed numbers raw (`annot` frame, ggplot `fill_` column).
- **`by value` on the 3D, Scatter and Network viewers is the Heatmap's colour domain, not a copy**
  (`colorParams({ valueScale })`, `style/encoding.ts`). Automatic bottom is the *data's* minimum; a
  centred ramp is symmetric, so no `Min` and no log; numeric-only is `ColorBy`'s `dtypes` per mode.
- **A heatmap rectangle selection is stored as positions, never labels** — a heatmap's names are
  not identities (the Labels tab is one-to-many). One param for both axes (one undo step); adding is
  a union; bands are outlined, never tinted, in a white-dashed-over-black pair since no hue survives
  every ramp. `label`/`relabel` stay two columns; the reshaping is memoised (selection is in the key —
  see [docs/nodes-tables.md](docs/nodes-tables.md)). A dragless press is `cellAt`, never a zero-width
  `linesInRect`; `nokey` lets a card take the gesture and the modified click must still be stopped.
- **The heatmap's zoom is a window in matrix units that gets *folded*, never a scaled canvas** —
  labels must not scale. The colour domain is memoised apart from the window (a pan must not rescan,
  a zoom must not recolour). Cells are an `ImageData` blit, the frame's raster being invisible to any
  `performance.measure`; the sliver test needs a tolerance.
- **The dendrogram zooms along the leaf axis only** — the distance axis is the measurement, so a
  drag along it does nothing by design. While zoomed only, pan; the "a drag happened" flag is a ref
  (state would re-reconcile every bracket); pointer capture at the slop, not the press, or the
  `click` is lost. All three are `usePanGesture`'s; the wheel is `useWheelZoom`'s. Memoise the window.
- **A dendrogram leaf's *name* is a drawing and its *label* the identity** — the Annotations pickers
  are `presentational` + `optional` and `evaluate` never reads them, since `cluster.selectedToNeurons`
  matches the label. An unnamed leaf keeps its label. **The Heatmap's same port is data** (Filter and
  Order read it); `displayLabels` is shared, each caller deciding.
- **Restoring neuroglancer `layers` under the pointer leaks a hover subscription that throws on every
  mouse move** — hold updates until `mouseleave`, and pass every id through `isSegmentId` in
  `buildScene` (one bad id kills the layer). `proxiedViewer` says a prefix is declared, not served.
- **The Neuroglancer card embeds Coda's own `neuroglancer.html` (Spelunker, `vendor/`), which is what
  makes `Selected` readable.** `Link` is always the datastack's viewer; `Viewer type`/`Viewer` choose
  only the frame (`frameTarget`) and are presentational. Picks are `+id`/`-id` edits
  (`selectionEdits.ts`) folded against the **scene last sent**, never the input, and only from a
  report naming the latest update (`FRAME_UPDATE_KEY`); a selection-only change is set in place
  (`selectionChanges`). The camera is saved (`view`, `unrecorded`). CAVE tokens go in as a
  `middleauthapp` provider, never into its storage. Dev: keep it out of `optimizeDeps`; no `ng*` page.

### Backends and data — [docs/backends.md](docs/backends.md)

- **An edge list is not a skeleton.** `SkeletonGeometry.parents` is a rooted tree in *visit order*;
  `spanningForest` (`src/data/skeletonTree.ts`) is the one walk from an undirected graph that may
  hold cycles and components — a surviving cycle makes every walk to a root loop forever.
- **A skeleton is not one product; which route answered rides on the value**
  (`SkeletonsValue.provenance`). `skeletonSourcesFor`'s order *is* `fetchSkeletons`' preference
  (and `capabilitiesFor`'s source); a pinned route the dataset lacks is an error, never a
  substitution (`requireSkeletonRoute`). See also [docs/nodes-morphology.md](docs/nodes-morphology.md).
- **A mesh source can resolve to somewhere with no meshes, and a dropped fragment is a short mesh
  under a green node.** `isVolumeInfo`, not a `switch` on `@type`; a graphene `~layer/shard:off:len`
  name is a `Range` read. Tolerated partial answers are counted *on the value*
  (`MeshDetail.fragments`), `unaddressable` apart from `missing`, a wholly failed neuron its own line.
- **A cost warning is priced over a *set*, never a lone neuron** (the one you measure alone is a big
  one), and states a wait, not a count — `MESH_WARN_SECONDS`, with the neuron threshold derived.
- **One control cannot mean "pick a published level" and "recompute the geometry".** `Detail` picks
  among published levels and is drawn dead where there are none (`undefined` = not yet looked);
  `Downsample` is a factor on the request, default **1**, `0` automatic, `absentMeans: 0`.
- **A draw call has its own limit, and it is not memory.** Firefox silently refuses a draw past
  30 M indices, so `drawRanges`/`MAX_INDICES_PER_DRAW` split the index only, sharing `position` and
  `normal` objects; normals computed once over the whole mesh, or a seam. Decimation factors are
  fitted, not calculated.
- **A tolerated failure and a global alarm cannot be the same line.** A speculative request — every
  peek — carries `quiet`; `refuseAuth` is the one site that reports. `missing_tos` is not a bad
  token. A tolerated refusal is still an answer: `DataSource.whyDatasetMissing` (`undefined` = not known).
- **A sign-in is a popup and a `postMessage`, and every hard part ends silently** (`popupSignIn.ts`).
  CAVE: prefix from `/auth_info`; window opened blank *before* the await; accept a message only from
  our window *and* the discovered origin; keep the paste field. DatasetGateway posts only to an
  exactly-matched registered origin and answers others `"badorigin"` — a refusal, not a close.
- **A geometry is the morphology of exactly the id asked for — never an id mapped to another
  timepoint**, and a skeleton's compartments are the source's codes, never `out.topology`'s. See
  [docs/cortex.md](docs/cortex.md).
- **A failed lookup has not answered "none"; only a 404 is a verdict** (`isNotFound`), never a cancel,
  5xx or `429`, and a shared in-flight request carries nobody's signal. The skeleton service's `exists`
  is rate-limited, so name the set first (`DataSource.planSkeletons`).
- **CAVE's row cap is per deployment, and a reference table has no root id.** Test truncation against
  the server's own `COUNT`, never `CAVE_MAX_ROWS` and never `>=`; a reference table (`target_id`) is
  read through the *join* endpoint (`select_column_map` only; ignores `count=true`).
- **A published token is not a credential** (`publicTokens.ts`, [docs/catmaid_vfb.md](docs/catmaid_vfb.md)):
  it loses to a user's own token, a 401 drops it and retries (never a user's), and the manifest is
  fetched `cache: 'no-cache'`.
- **A ZapBench trace is priced in 512-neuron *blocks*, and its id is the 1-based label, one above the
  column** (`traceColumnOf`) — a wrong offset returns the neighbouring cell's real trace. Rule 3 can
  substitute the picker, so `excludeIds`, a `validate` warning and a range refusal all stay; the node
  emits a matrix only. See also [docs/nodes-io.md](docs/nodes-io.md).
- **The release holds two transposed copies and the reader costs both per request** (bytes plus
  `REQUEST_BYTES_EQUIVALENT`); the cost warning is priced from the *chosen* plan. The permutation is
  checked, never trusted (`verifiedSorting`); `sorting.ts` imports nothing from `traces.ts`; the
  pyramid averages neighbouring *cells* too, so it never answers one neuron's trace.
- **A reduced-scale row is a bin labelled by the cells it averages** (`cellLabel`/`cellIdsOf`), so the
  lookup needs no scale param. `verifiedLevel` refuses on failure; a numeric property is looked up as
  a number per the **discovered schema**, or matches nothing; the lookup takes `datasetRequest`.

### The shell — [docs/ui-shell.md](docs/ui-shell.md)

- **The document must never be wider than the viewport** — a non-wrapping row zooms a phone out, and
  neither a desktop browser nor jsdom shows it (`pnpm probe:mobile`). Below `NARROW_QUERY` (width
  only) the row folds into `⋯`, stamped as `data-narrow`; a plain media query where no React branch
  pairs with it. A control's `label` is its menu row *and* accessible name; chords from `shortcutKeys`.
- **A submenu opens right, else left, else under its row, by measurement** (`submenuPlacement` over
  `useMenuFit`), not a flip and not a phone rule. A top-level menu is nudged (`menuShift`) against
  `documentElement.clientWidth`, never `window.innerWidth`; open panels key off stamped attributes,
  never `:has()`.
- **Small screens get a notice, not a layout** — a media query on both axes; the guides dialog returns
  null behind it (invisible to jsdom, whose `matchMedia` is always `false`); record *that* it was
  acknowledged, never the size.
- **`overflow-y: auto` clips the other axis too**: a `Dropdown` with a flyout passes `flyouts`. A
  shortcut glyph is stored by meaning (`src/ui/shortcuts.ts`, `formatChord`); `Editor.tsx` owns the bindings.
- **A message naming a remedy renders through `IssueText`**, with `user-select: text` *and* `nodrag`;
  the visible text is the href, `http`/`https` only.
- **Nothing opens a dialog during a tour** (`isTourActive()`, else the status bar). A tour anchor
  with a `??` fallback resolves instantly, ending driver's wait early; `TourStep.when` is asked once.
- **The launch sequence is one boolean and a stage, read only through `useLaunchStage`.** Shown once
  ever, written on sight; a checkmark means walked to the end, never dismissed.
- **The Screen Map's placement is computed, so it is tested as a pure function over rects**
  (`mapLayout.ts`) and in a browser (`pnpm probe:screen-map`). Nothing is dropped; an off-screen spot
  is not mapped; below `NARROW_QUERY` a list. Shared anchors and helpers stay outside the driver.js
  `import()`; a map in a node body is scoped, portalled and on `useOverlayEscape` above the viewer.
- **The memory meter subtracts held typed arrays** (they count in `usedJSHeapSize`, not against
  `jsHeapSizeLimit`), and `ByteLedger` charges each array and buffer once. `performance.memory` is
  frozen on `about:blank`.
- **A run notification is opt-in, the tab title is not.** Permission is asked only from the bell's
  click; `denied` is terminal, so pressed = preference **and** `notifyState()`. `flashTitle` always
  runs and captures the replaced title once. Away is `visibilityState` or `!hasFocus()`.
- **One node is never live in two full-size surfaces** — the store refuses one id in both
  `pinnedNodeId` and `expandedNodeId`. The canvas column is `minmax(0, 1fr)`; the dock width is a
  fraction, and which node is pinned is never stored.
- **A Scheduler per document, never one shared** — two documents from one file share node ids and
  keys. Freshness is derived (`refreshStates` on arrival); capture the viewport on `onMove`, not
  `onMoveEnd`; every open route mints a document, reusing a blank historyless one; `newGraph` stays
  the in-place reset.

### Persistence and documents — [docs/persistence.md](docs/persistence.md)

- **A run state is derived (`refreshStates`), and every path that sets a graph must derive it —
  boot included.** Nothing in the store's initialiser may notify the host (zustand hands a `set`
  there `undefined`; answered by *position*, not a readiness flag), and **deriving is not running**.
- **The open set lives in two stores, split by *when* it is needed:** the active document in the
  synchronous `localStorage` slot (it decides first paint), every other in IndexedDB (the 5 MiB
  quota swallows overflow silently). `loadActiveDocId` is synchronous `sessionStorage`; the restore
  is additive and never activates; past `MAX_SLOTS`, `fromSlot` says which store answered.

### The dashboard — [docs/dashboard.md](docs/dashboard.md)

- **A dashboard cell is a reference to a node id, and the grid replaces the canvas** (React Flow
  unmounts). At most one cell per node per tab, drawable nodes only — enforced in `addCells` *and*
  `validDashboard`. The layout is in the document: written only when true, never minted by a mode
  toggle, never an undo step. Row height is measured, not `1fr` or `vh`.
- **A cell is on screen before the run**, so input-drawing viewers read `nodeInputs` in
  `ViewerSurface`; adding `runVersion` as a dep is not the fix. `previewVersion` is subscribed
  **ungated** there (a non-viewer can hold a cell); test by running *underneath* a mounted grid.
- **A run's denominator is its scope** — the bar reads `Scheduler.runProgress()` via
  `resolveScope`, through its own `onRunProgress` channel. `useRunProgress` returns the
  Scheduler's own object (a selector minting `{done, total}` is an infinite render).

### The scheduler and loops — [docs/core.md](docs/core.md), [docs/loops.md](docs/loops.md)

- **A new run supersedes the walk, never the work.** A newer walk **adopts** an evaluation owned by
  its provenance key, a key-moving edit **retires** it (`retireMoved`), only Cancel stops all.
  `refreshStates` leaves a live `running` badge alone; a cheap pass during a Run goes through
  `runFull` (`requestedFull`). Loops are excluded on purpose.
- **A `reference` that resolved to nothing is refused by the scheduler, not the node** — the node
  sees one `undefined` for two states. `gatherInputs` builds `GatheredInputs.refusal` from the
  referenced node's inference issues, after `blocked` and the auto-pass deferral.
- **A loop is one number in a hash** (`Scheduler.loopIndex` in the begin node's key), so the region
  is derived from the wires. It runs at the region's **last** node; a `Collect` never takes a cache
  hit mid-pass; per-pass files go through the awaited `SchedulerHost.onIteration`.

### The wizard, the pages and the help — [docs/wizard.md](docs/wizard.md), [docs/pages.md](docs/pages.md), [docs/help.md](docs/help.md)

- **The Workflow Wizard's options are gated, not offered** (`capabilityAnywhere`, `VIEWS`). Ask the
  ceiling, not the floor; **`capabilityOf` answers `true` for an unregistered source**, so register
  before enumerating at module-init/SSR. Its one layout pass is a builder's request, run ahead of
  `loadGraph`'s auto-layout stand-down. The view question remembers **refusals**, not an allow-list.
- **Multi-dataset mode is derived from `WizardAnswers.datasets`' length** (`isMulti`), never a flag.
  `prefixChain` rewrites a whole chain; every dataset meets on one variadic `Stack Neurons`. See
  [docs/comparative.md](docs/comparative.md).
- **A dataset's typing chain is a declaration, `DatasetFamily.annotationChain`, never a bespoke
  graph or baked into the node**; only origin and step belong to a builder. Replacing built-in
  labels declares `staleBuiltin` (fix: `attachChain`). See [docs/datasets.md](docs/datasets.md).
- **A static page's link names a workflow (`demo://`), never carries one, and the search runs at
  build time** — scoring peeks (`inferGraph` → credential dialogs). Wiring is scored, not reasoned
  about; the in-app `?` scores only the synthetic dataset and takes the trail's tail.
- **The node guide's anatomy figure is a hand-written copy of the card**, so `anatomy.test.ts`
  holds every glyph and `title` against the card's source. Labels authored, boxes measured; ask the
  breakpoint of the stylesheet, never a `matchMedia` string.
- **"See also" is a table of groups (`src/help/seeAlso.ts`), never derived from the documents'
  links**, which are mostly one-way. `seeAlso.test.ts` pins symmetry and no dead ends.
- **A thumbnail is not always a mesh:** `CoarseGeometry.kind` is required on both arms, or the tile
  silently draws blank. See [docs/widgets-explore.md](docs/widgets-explore.md).

## Chart colours

- **Never pick chart colours by eye.** `src/style/colors.ts` was validated with the `dataviz`
  skill's validator; change the palette, re-run it — don't reason about ΔE. A new categorical
  palette is a published set transcribed, never mixed hues.
- **Only three chromatic families clear the all-pairs colourblind gate on the dark surface**, so a
  socket type is colour *plus* shape *plus* a visible label; a fourth socket hue fails.
- **`CHART_INK.grid` is chrome only** (under 3:1 by design); data — network links, arrowheads —
  takes achromatic `muted`.
- **Fold where the mark folds:** `seriesColor` (folds past eight onto `Other`, `foldByRank`) for
  bars, slices, segments, boxes; `cycleColor` for nodes, points, neurons, with `+N more` /
  `colours repeat` saying so. See [docs/viewers-network.md](docs/viewers-network.md).

## The rest, by area

Each is a design record: what was tried, what was measured, which failures are silent.
**Read the one for the area you are about to change.** Ordinary links, deliberately not
`@`-imports: an `@docs/…` in a CLAUDE.md *imports* the file, pulling ~3 MB into every session.

- [adding-a-node.md](docs/adding-a-node.md) — the main extension point; start here for any new node.
- [testing-layers.md](docs/testing-layers.md) — which test file covers what; check before writing one.
- [invariants.md](docs/invariants.md) / [gotchas.md](docs/gotchas.md) — the incidents behind the rules above.
- [limits.md](docs/limits.md) — every guard rail, its tier, `ctx.warn`. Read before adding a number that stops somebody.
- [core.md](docs/core.md) — the two caches, `ctx.refresh`, auto-run, reference edges.
- [canvas.md](docs/canvas.md) — fit-on-load, the lock, and the index; then [layout](docs/canvas-layout.md)
  (ELK, companions, packing, align), [editing](docs/canvas-editing.md) (hints, groups, folding, clipboard),
  [interaction](docs/canvas-interaction.md) (measurement, sockets, **+** menu, glyphs),
  [wiring](docs/canvas-wiring.md) (wire drops, splice, re-routing, port preview).
- [loops.md](docs/loops.md) — `For Each` / `Collect`, the region, `onIteration`.
- [viewers.md](docs/viewers.md) — shared viewer machinery (export, tooltips, table filtering, styling
  sidebar) and the index; per viewer: [viewers-3d.md](docs/viewers-3d.md),
  [viewers-network.md](docs/viewers-network.md) (+ Flow Chart, Sankey, Metrics),
  [viewers-matrix.md](docs/viewers-matrix.md) (Heatmap, Dendrogram), [viewers-charts.md](docs/viewers-charts.md),
  [viewers-neuroglancer.md](docs/viewers-neuroglancer.md).
- [widgets.md](docs/widgets.md) — the surfaces that fetch for themselves, one file each:
  [explore](docs/widgets-explore.md), [profile](docs/widgets-profile.md),
  [summary](docs/widgets-summary.md), [roi-viewer](docs/widgets-roi-viewer.md).
- [nodes.md](docs/nodes.md) — per-node index into [nodes-tables.md](docs/nodes-tables.md),
  [nodes-morphology.md](docs/nodes-morphology.md), [nodes-connectivity.md](docs/nodes-connectivity.md),
  [nodes-io.md](docs/nodes-io.md).
- [datasets.md](docs/datasets.md) — families, Custom backends, the Description companion, auto-wiring;
  datasource vs dataset (`SourceCapabilities` keeps a Neuroglancer Source honest).
- [backends.md](docs/backends.md) — the geometry cache and streaming, and the index; per backend:
  [neuprint](docs/backends-neuprint.md), [cave](docs/backends-cave.md),
  [cave-geometry](docs/backends-cave-geometry.md), [catmaid](docs/backends-catmaid.md),
  [precomputed](docs/backends-precomputed.md), [dvid](docs/backends-dvid.md),
  [zapbench](docs/backends-zapbench.md). Read before touching `src/data`; `precomputedToHttp` is
  deliberately narrower than its parser — don't widen it.
- [comparative.md](docs/comparative.md) — two connectomes in one table. **`Match Cell Types` derives
  every correspondence** (hand-written ones go in a downstream `Relabel`), and the one user assertion
  is a separate pass over what it left empty, never a relaxed `coversAll`.
- [neuronbridge.md](docs/neuronbridge.md), [dotmotif.md](docs/dotmotif.md),
  [annotations.md](docs/annotations.md), [catmaid_vfb.md](docs/catmaid_vfb.md) — single features.
- [export.md](docs/export.md) — notebook and R Markdown exporters, refusals, goldens.
- [python-pyodide.md](docs/python-pyodide.md) — the bridge; read before adding a Python capability.
- [persistence.md](docs/persistence.md), [recipes.md](docs/recipes.md) — share links, autosave,
  shelf; recipes as fragments plus slots.
- [wizard.md](docs/wizard.md) — what the Workflow Wizard can build, and why.
- [assistant.md](docs/assistant.md) — **read before touching the prompt.** Type facts go in the
  catalogue, instance facts in the graph listing; five runs per side is the floor for judging a change.
- [mcp.md](docs/mcp.md) — **every export of `src/mcp/index.ts` is a public interface**; a breaking
  change is a `v2` directory. [deployment.md](docs/deployment.md) — the hosted server.
- [packs.md](docs/packs.md) — read before adding a pack, a shortcut, or moving nodes into one.
  Packs: [cortex.md](docs/cortex.md), [biophys.md](docs/biophys.md).
- [zoo.md](docs/zoo.md), [analytics.md](docs/analytics.md), [seo.md](docs/seo.md),
  [ui-shell.md](docs/ui-shell.md), [dashboard.md](docs/dashboard.md).
- [pages.md](docs/pages.md) — the extra vite entries; each stays out of the main chunk.
- [help.md](docs/help.md) — **read `## Voice` before writing a help document**; a callout is for
  behaviour a reader would not predict, never a design decision.
- `docs/*-plan.md`, [prior-art.md](docs/prior-art.md) — plans and surveys, not records of what is built.

**jsdom performs no layout and has no WebGL**, so geometry and pixels are driven in a real browser.
**Every measurement in the docs was taken, not estimated** — re-measure rather than reasoning one
forward.
