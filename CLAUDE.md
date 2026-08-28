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
symptom to recognise — which usually points nowhere near the cause.

- **`defaultSize` sizes React Flow's _wrapper_, and only a viewer's card fills one**
  (`category: 'visualisation'`). Elsewhere it leaves the state bar hanging below the
  card. A node that only wants to be wider sets `NODE_BODIES[type].width`.
- **Two wires between the same pair of nodes are not a cycle.** `topoSort` derives
  indegree from the same index that decrements it, so the two cannot disagree again.
- **A column picker keeps a chosen column rather than substituting.** A schema without a
  column is very often a schema that has not *arrived*. Substituting cost 9 GB once.
- **A picker on its own declared default still resolves before the schema lands**, and an
  unset *required* picker means its declared default. On an `optional` picker, empty is a
  decision and stays one.
- **A multi-column picker keeps an unseen list untouched** — a schema this picker cannot
  see is not a schema without these columns in it.
- **Both peeks start the fetch they cannot answer** (`peekDatasets`, `schemasFor`), once
  per instance. Otherwise the first Run of a session behaves differently from the second.
- **A node whose output size is the product of two independently-resolved columns needs a
  ceiling checked before allocation** — neither picker knows what the other did.
- **A guard rail warns; it does not refuse.** Coda's ceilings were all `throw`s, at numbers a
  prototype could demonstrate — 100 neurons for NBLAST, 20 for a CAVE mesh batch — and a refusal
  is a claim that there is no useful answer, which for a count is almost never true. `ctx.warn`
  is the channel; `CRASH_FLOOR_BYTES` is the only thing left that refuses, and only for an
  allocation. Time is never a refusal. See [docs/limits.md](docs/limits.md).
- **An edge list is not a skeleton.** `SkeletonGeometry.parents` is a rooted tree in *visit order*
  — a parent always precedes its child — where both backends that build one start from an
  undirected graph that may hold cycles and disconnected components. `spanningForest`
  (`src/data/skeletonTree.ts`) is the one walk; a cycle that survives into `parents` makes every
  consumer that walks to a root loop forever.
- **A buffer handed to `callPython` is detached the moment the call is posted**, so read
  anything about it — its length above all — *before* the await. A check against a transferred
  buffer's `length` compares a real count against 0 and always fails.
- **`overflow-y: auto` clips the other axis too**, so a `Dropdown` holding a flyout submenu must
  pass `flyouts` to switch the panel's scroll off. There is no "scroll one axis, overflow the
  other" — without it the submenu renders as a horizontal scrollbar. Only the `?` menu opts out,
  and only because it is short enough never to need the scroll.
- **A shortcut's glyph is stored by meaning, not as text.** `src/ui/shortcuts.ts` is the one
  table; a chord is `{ mod: true, key: 'Z' }` and `formatChord` is the only place that knows ⌘
  from Ctrl. Four surfaces read it — the dialog, the palette badges, the status bar, the start
  page — and when each typed its own glyph, all four told Windows to press a key it does not
  have. `Editor.tsx` still owns the *bindings*; adding one means adding an entry here too.
- **A group frame is not a React Flow node, and three viewport properties keep it honest.** It is
  drawn into `ViewportPortal` at `z-index: -1` (last child, so it would otherwise paint over every
  card), takes the pointer only on an SVG rect with `pointer-events: stroke` (the interior must
  stay click-through, or the canvas inside a frame stops panning), and wears `nopan`, because
  panning is d3-zoom's *native* listener below React's root and `stopPropagation` cannot reach it.
  Membership is a list of node ids and the box is derived — `parentId` would re-base every child's
  `position`, which five subsystems read absolutely. See [docs/canvas.md](docs/canvas.md).
- **CAVE's row cap is a per-deployment number, and a reference table has no root id.**
  `CAVE_MAX_ROWS` is one server's `QUERY_LIMIT_SIZE`, not a property of CAVE — FlyWire truncates
  at exactly 500,000, BANC returned all 1,994,371 rows of `codex_annotations` — so truncation is
  tested against the server's own `COUNT` of the same query (`countTable`), never against the
  constant, and never with `>=`. And a `cell_type_reference` table carries `target_id` and no
  root id at all: reading one means the *join* endpoint, which takes `select_column_map` and only
  that, and does not honour `count=true`. Both failures read as facts about the data.
- **A thumbnail is not always a mesh.** `CoarseGeometry` is a union — `{ kind: 'mesh' }` or
  `{ kind: 'skeleton' } & SkeletonGeometry` — because a `graphene://` datastack has no cheap mesh
  *at any level* while its level-2 chunk graph is two requests, so a mesh-shaped seam left BANC
  and MICrONS with a placeholder in every row. `kind` is required on both arms: inferred from
  which field is present, a source that forgot it is a silent fall-through to the mesh branch and
  a blank tile. CATMAID is the same case for a different reason — tracing, no segmentation — and
  is the expensive one: a traced FAFB skeleton is 0.9–4.2 MB uncompressed, with no byte ceiling
  on purpose, because on a source whose typical body is megabytes a ceiling blanks the neurons
  anybody is looking for. Both rasterisers in `src/ui/explore/thumbnail.ts` share one `fitToTile` — two
  copies drift and frame mesh rows and skeleton rows differently in one list — and
  `drawSegment` stamps along the major axis rather than filling a quad, because a two-pixel
  diagonal quad through a barycentric fill draws a *dotted* neurite. See
  [docs/widgets.md](docs/widgets.md).
- **`@type` is optional on a precomputed volume, and a graphene manifest is not all shards.**
  Two ways a mesh source resolves to somewhere with no meshes in it, both reported as neurons that
  have none. A flat segmentation published before `@type` was conventional declares only `type`,
  `scales` and a named `mesh` — `gs://flywire_v141_m783` — and a `switch` on `@type` read it as a
  legacy mesh directory *at the bucket root*, hiding two pyramids and a skeleton set;
  `isVolumeInfo` is the one predicate both `openMeshSource` and `probe.ts` ask. And a verified
  graphene manifest mixes shard reads with plain objects under `mesh_metadata.unsharded_mesh_dir`
  — BANC, 40 sharded and 21 not — which read from the mesh root 404 one at a time, so the neuron
  arrives whole minus every piece anyone has edited. `fragmentUrl` matches on `.shard:`.
  See [docs/backends.md](docs/backends.md).
- **A loop is one number in a hash, and the region is derived from the wires.** `For Each` has no
  sub-graph: `Scheduler.loopIndex` is session state folded into the begin node's provenance key, so
  advancing it re-keys every descendant and invariant 4 re-runs the region — a pass is
  indistinguishable from an upstream edit. Three consequences that each read as something else. The
  loop executes at the position of the **last** node of its region, not at its begin node, or a body
  that also reads a branch from beside the loop runs before that branch has been reached. A settled
  loop does **not** re-run on the next Run — `out.download`'s contract, which is why the index is
  left at `count - 1` rather than reset, and why nothing downstream needs a loop-invariant key;
  but freshness describes a *pass*, so a **cancelled** loop's region is entirely fresh and
  `loopDone` is what stops it settling with half its elements unprocessed. A `Collect` is the one
  node a cache hit must never answer for mid-pass, its other input being the previous pass.
  And `RunSummary.executed` is a *set of node ids*, so it cannot say a Download ran four hundred
  times: per-pass files and pictures come through the awaited `SchedulerHost.onIteration`, and
  `loopNodes` is what stops `useDownloads` adding a stray four-hundred-and-first file. See
  [docs/loops.md](docs/loops.md).
- **A shader patch that stops matching is silent, and a neuron's width was in the data all along.**
  `SkeletonGeometry.radii` is filled by all three skeleton backends and was drawn by none of them,
  because three's `LineMaterial` takes one `linewidth` uniform. `flexLineMaterial.ts` rewrites the
  one site in three's own `line` vertex shader that reads it — the same three-line diff octarine's
  `shaders/lines.py` makes against pygfx's `line.wgsl`, one graphics API over. Patching beats
  replacing: the quad, the endcaps, the near-plane trim and the cap AA are all inherited, and the
  cap comes out per-node for free because the width is applied *after* the endcap extension. The
  trap is the upgrade: rename a variable in `ShaderLib` and the patch matches nothing, the material
  still compiles, and every skeleton silently draws at the uniform width. So it throws rather than
  falling back, and `flexLineMaterial.test.ts` runs the patch — `ShaderLib` is plain text, which
  makes this the one piece of the fat-line path jsdom can reach. Scaling is against the **p95**
  radius, never the maximum, or one runaway node flattens the arbour onto the 1px floor; and that
  floor is required, because CATMAID's unset radius and a small CAVE L2 chunk are both 0 and would
  otherwise take the twigs off the picture. See [docs/viewers.md](docs/viewers.md).
- **A width in world units is two more patch sites that must agree, and three's ray is 1e5 units
  long.** `to scale` draws the same radii in nanometres rather than pixels — pygfx's
  `thickness_space`, the mode octarine defaults skeletons to. The vertex shader extrudes the box
  and the *fragment* shader carves the tube out of it, so patching one without the other is either
  a wider box with an unchanged silhouette or a tube clipped flat by its own box. Two consequences
  that each look like something else. `vec3 rayEnd = normalize( worldPos.xyz ) * 1e5` is generous
  in a scene measured in metres and exactly 100 µm in one measured in nanometres — past that the
  ray stops short, `closestLineToLine` clamps, and **every fragment discards**: the arbour vanishes
  whole in one zoom step (measured: blank between 73 px and 60 px of on-screen extent, where the
  screen-space modes drew down to 32 px). And the pixel floor cannot be a number of nanometres, so
  `MIN_WORLD_PIXELS` is applied per vertex in the shader where the projection is known —
  `abs( clip.w )` is the view depth under perspective and 1 under orthographic, which is the whole
  difference between the two cameras. What it does **not** buy is skeletons in the AO pass: the
  geometry is a camera-facing box, the tube is a fragment `discard`, and the vertex shader
  overwrites depth with the endpoint's (`clip.z = clipPose.z * clip.w`) so segments overlap
  neatly. Real tubes are a different feature; octarine's `shaders/tubes.py` is what that costs. A
  screen-space width and a world one differ in an *exponent*, not in any one frame, so the check
  is ink against extent across a zoom sweep: p = 1.0 for both pixel modes, 1.6 for `to scale`.
  See [docs/viewers.md](docs/viewers.md).
- **A post-processing pass moves the background out from under the scene, twice.** Ambient
  occlusion means an `EffectComposer`, and a composer renders into a texture — which broke the
  canvas colour in two ways that no test could see and that only appear once the toggle is on.
  `RenderPass` sets the clear colour *before* it binds the target, so the surface was converted
  for the screen and then encoded again by `OutputPass` (`#1a1a19` → `#585855`); `scene.background`
  is painted inside `renderer.render` and is the fix. And tone mapping is per-*material* in the
  ordinary path but per-*image* through a composer, so R3F's default ACES curve reached the
  background only under AO (`#1a1a19` → `#080808`) — hence `<Canvas flat>`, which also changes how
  surfaces look and is a trade rather than a freebie. Two more seams the composer owns:
  `setSize` takes **CSS pixels** and applies its own pixel ratio (`getDrawingBufferSize` applies it
  twice and quietly quarters the AO resolution on retina), and the PNG export renders its own
  frame, so it has to render through the chain or a figure comes out without the effect that is on
  screen. The pass itself is only *mounted* where there is something to occlude: every line and
  point is hidden before its normal pass, so a skeleton scene — most of them — would pay four
  passes to multiply the image by 1. Only two of the three classes are three's job, though:
  `_overrideVisibility` tests `isPoints || isLine || isLine2`, and a **fat** line is a `Mesh`
  carrying `isLineSegments2` — so it reached the normal pass with `MeshNormalMaterial` swapped in
  and drew a two-unit box at the model origin into the g-buffer, subpixel at 10⁵ nm and not
  subpixel on one small neuron. `hidesFromGtao` is the missing third. **Both** its world-unit uniforms are rescaled: `radius` to 4%
  of the scene extent, never the 0.25 default, *and* `thickness`, whose default of 1 is a
  one-nanometre depth cutoff that rejected every sample the estimator took and blended a uniform
  white — a library's world-unit defaults are a set that agree with each other, so rescaling one
  is a different kind of broken, not a partial fix. When an effect's magnitude looks too small,
  render its own buffer (`GTAOPass.OUTPUT.Denoise`, octarine's `debug=True`) before writing down
  a reason the number is small; a plausible story about thin convex geometry is what stopped that
  investigation one step short. Measure on a real GPU: headless Chrome falls back to
  SwiftShader and reported this pass as 2.5× frame time where hardware shows none. Its strength
  is one slider where 0 is off, not a toggle plus a strength — the blend is `mix(1, ao, k)`, so a
  checkbox would be a second spelling of `k === 0` and the two can disagree. And **a `useMemo` may
  be reused across a remount while an effect cleanup always runs**: writing the pass into a ref
  inside the memo and nulling it in the cleanup meant the *first* strength change applied and
  every later one silently did not. Return the object from the memo instead.
  See [docs/viewers.md](docs/viewers.md).
- **Module init order.** `graphStore.ts` imports `../nodes` for its side effect. Without
  it, ordering in `main.tsx` becomes load-bearing and silently drops every node.
  The same trap one level in: a Node-side script needs `registerBuiltinSources()` as well, or
  the nodes resolve and then every dataset node reports "Data source is not registered". Both
  failures are total and both read as a data problem. `src/data/builtins.ts` is the one set.
- **One `fetchText`, in `src/data/fetchText.ts`.** Its own comment warns that two functions of
  one name two directories apart is a grep hazard — and it was then copied from
  `share/resolve.ts` into `zoo/source.ts`, making the warning true in the codebase that wrote it.
  A cross-origin GET that has to tell "unreachable" from "CORS refused" is that function.
- **A generated file that is committed must not carry a wall clock.** `ZooIndex.updatedAt` is
  the newest entry's commit date, not `Date.now()`, so `zoo-index --check` can byte-compare it.
  Stamped from a clock, the file differs from itself on every run — and the check that catches a
  contributor who forgot to regenerate silently stops working.
- **`parseMarkdown`'s extended kinds are opt-in, and that is a safety property.** Fences,
  callouts, tables and images parse only under `{ extended: true }`. A dataset blurb arrives from
  whatever deployment a Custom node points at; an image in one is a tracking pixel, and a fence
  is a directive some renderer may act on. Only `src/help` opts in.
- **Whole-string patterns are anchored, in one place.** `anchoredPattern` (`data/terms.ts`)
  wraps them in `^(?:…)$` to match Neo4j's `=~`, so `LC.*` matches `LC4` but **not** `LPLC1`.
  Every builder goes through it — a request pattern, a filter row lowered for a local source,
  and the same row compiled to Cypher. Don't "fix" this.
- **`localStorage` is undefined** under Node 26 + jsdom. Tests use `clearStorage()` /
  `installStorageStub()` from `src/test/jsdomStubs.ts`.
- **React Flow needs measurements.** In jsdom, unmeasured nodes are `visibility: hidden`,
  so component tests pass `{ hidden: true }`. `installJsdomStubs()` supplies
  ResizeObserver, `getBoundingClientRect`, `matchMedia` and a 2D canvas context. WebGL
  stays absent on purpose.
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

## The rest, by area

Moved out of this file verbatim. Each is a design record: what was tried, what was
measured, which failures are silent. **Read the one for the area you are about to
change** — most entries exist because the obvious approach was wrong.

Ordinary links, deliberately not `@`-imports: `@docs/foo.md` in a CLAUDE.md *imports* the
file, pulling all 620 kB back into every session and undoing the split.

- [docs/testing-layers.md](docs/testing-layers.md) — which test file covers what. Check
  before writing a test, and where a new one belongs.
- [docs/invariants.md](docs/invariants.md) — the incident behind each invariant above.
- [docs/gotchas.md](docs/gotchas.md) — the incident behind each gotcha.
- [docs/adding-a-node.md](docs/adding-a-node.md) — the main extension point. Start here
  for any new node.
- [docs/limits.md](docs/limits.md) — every guard rail, its tier, and the `ctx.warn` channel.
  **A limit warns; it does not refuse.** Read before adding a number that stops somebody.
- [docs/core.md](docs/core.md) — the two caches and `ctx.refresh`, auto-run, reference
  edges. Read when adding `dataCache` or a `reference` port.
- [docs/canvas.md](docs/canvas.md) — React Flow settings, ELK layout, edge routing,
  collapse/fold/resize, splice-onto-wire, rewiring links, fit-on-load.
- [docs/loops.md](docs/loops.md) — `For Each` and `Collect`: the region, why a loop is not a
  subgraph, the `onIteration` seam, and the two routes a loop's files take. Read before touching
  `runLoop` or the file sink.
- [docs/viewers.md](docs/viewers.md) — every `out.*` widget, the shared export path,
  encodings, tooltips, table filtering, number formatting, the styling sidebar.
- [docs/widgets.md](docs/widgets.md) — Explore Dataset, Neuron Profile, Dataset Summary,
  ROI Viewer: the surfaces that fetch for themselves rather than reading a wire.
- [docs/nodes.md](docs/nodes.md) — per-node semantics: Pivot, Deduplicate, both import
  nodes, Combine Columns, Select One, Stack, Download, Connectivity, Paths, both id
  nodes, Text notes.
- [docs/datasets.md](docs/datasets.md) — the family table, Custom backend nodes, the
  Description companion, auto-wiring, starter graphs. Also **datasource vs dataset**: a
  Neuroglancer Source emits a `Dataset` so the geometry nodes take it, and `SourceCapabilities`
  is the only thing keeping that honest.
- [docs/backends.md](docs/backends.md) — neuPrint, CAVE, CATMAID, precomputed. Read the
  relevant one before touching anything under `src/data`. `precomputedToHttp` is deliberately
  narrower than the source parser beside it and the reason is a measured one; don't widen it.
- [docs/comparative.md](docs/comparative.md) — comparative connectomics. The cell-type
  correspondence graph (cocoa's `GraphMapper`), type-level edge comparison, and neuron-level
  co-clustering. `Match Cell Types` is **built** (`nodes/analysis/matchTypes.ts` over
  `nodes/lib/typeMapping.ts`); `Relabel` and `Compare Connectivity` are not. Read before adding
  any node that puts two connectomes in one table — the qualified-id decision is recorded there,
  and why chaining a two-input mapper is a different computation rather than the same one twice.
- [docs/annotations.md](docs/annotations.md) — labels that do not come from the
  connectome: the Annotations socket, SeaTable, Google Sheets, root-id drift.
- [docs/export.md](docs/export.md) — the notebook and R Markdown exporters, the refusal
  policy, the emitter registry, the goldens.
- [docs/python-pyodide.md](docs/python-pyodide.md) — the Pyodide bridge and everything on it:
  NBLAST, syNBLAST, clustering, landmark warps, Clean Skeletons, Clean Meshes, NBLAST Matches.
  Read before adding a Python-backed capability — the six existing ones all declare the same two
  packages, which is the finding rather than a coincidence.
- [docs/persistence.md](docs/persistence.md) — share links, the autosave across tabs, the
  browser shelf.
- [docs/zoo.md](docs/zoo.md) — the Coda Zoo: the GitHub repository of deposited workflows, why
  the index is a committed file rather than an API listing, and why the validator lives here
  rather than there. Read before changing `ZooIndex` — a generator and a reader that disagree
  produce an index that passes CI and renders as nothing.
- [docs/ui-shell.md](docs/ui-shell.md) — panels, fullscreen and the manifest, the run
  indicator, the start page.
- [docs/pages.md](docs/pages.md) — overview, tutorial and node guide. Extra vite entries;
  each must stay out of the main chunk.
- [docs/help.md](docs/help.md) — the `?` on a node: the in-app overlay, the markdown documents in
  `src/help/nodes/`, and the figures that draw real registry objects. Read before adding a
  document or a fence language.

Two notes cut across all of them. **jsdom performs no layout and has no WebGL**, so
anything about geometry or pixels must be driven in a real browser; several entries record
bugs a green suite could not see. And **every measurement here was taken, not
estimated** — re-measure rather than reasoning one forward.
