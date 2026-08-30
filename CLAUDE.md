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
- **The analytics path is a literal, and both gates matter.** GoatCounter's default path is
  `location.pathname + location.search`; a Coda share link carries the whole workflow in the
  *fragment*, so nothing leaks today — but that is a fact about sharing, not a promise, and one
  query param would silently turn workflow content into analytics data. `vite/goatcounter.ts`
  sends a literal per entry, derived from the filename so a fifth entry cannot arrive unlabelled.
  The tag is `apply: 'build'` **and** gated on `CODA_ANALYTICS`, set only in `deploy.yml`: this
  repo is public and permissively licensed, so without the second gate a fork's readers get
  reported to a dashboard its operator never chose. There is deliberately **no event tracking** —
  counting page loads and watching what somebody builds are different propositions, and the
  second contradicts what `SourcesPanel` promises four times over.
  See [docs/analytics.md](docs/analytics.md).
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
- **A run notification is opt-in, but the tab title is not, and the fallback is the feature.**
  `Notification.requestPermission()` is refused outside a user gesture, so the bell's *click* is
  the prompt — there is nowhere else to ask. **`denied` is terminal**: a page can never ask twice
  and hears nothing when the user relents, so the stored preference is not the truth and the
  bell's pressed state is that preference **and** a live `notifyState()`. Three engines will never
  show one anyway — an uninstalled iOS Safari tab, Android Chrome (service-worker only; the
  constructor throws), and a refusal — which is why `flashTitle` runs unconditionally and captures
  the title it replaced **once**, or the tab says "Run finished" for the rest of the session.
  Away is `visibilityState` **or** `!hasFocus()`, because a covered window is still `visible`.
  A floor, not a manual/automatic test: what says somebody left is how long the run took.
  See [docs/ui-shell.md](docs/ui-shell.md).
- **A published token is not a credential, and shipping one makes a rotation a new failure mode.**
  Virtual Fly Brain publishes an `AnonymousUser` token per instance because CATMAID's query endpoints
  are POST-only and a browser satisfies neither of Django's CSRF gates: it cannot set `Referer`, and it
  can neither receive nor read a `SameSite=Lax` cookie from another origin, so the double-submit has
  nothing to submit. `publicTokens.ts` is a committed snapshot refreshed from their manifest in the
  background, and three of its rules exist because the obvious version fails silently. It **loses to a
  user's own token**, or a real VFB account's data disappears with nothing on screen to say why. A
  **401 drops it and retries** — `client.ts`'s loop stops at the first response it gets, so a rotated
  token would fail where an anonymous `GET` used to work, which is worse than never having shipped one;
  a token the *user* typed is never dropped, because that 401 really is about their credential. And the
  manifest is fetched `cache: 'no-cache'`, because it is served `immutable` with a one-year max-age and
  the refresh would otherwise run once per browser and then never again — presenting as the feature
  working. See [docs/catmaid_vfb.md](docs/catmaid_vfb.md).
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
- **A skeleton is not one product, and which route answered is a fact about the *value*.** A
  dataset usually has more than one place to get one from — `male-cns:v1.0` serves neuPrint's SWC
  and publishes a precomputed layer beside its segmentation (same 1,688 nodes on body 45882, same
  nanometres, no radii); `minnie65_public` has a level-2 cache and a populated CAVE skeleton
  service (7,167 vertices with radii against a few hundred chunk nodes). Cable length means
  something different down each, so `SkeletonsValue.provenance` rides on the value and the
  Skeletons node's `Source` is where you choose. Four rules, each load-bearing:
  `DataSource.skeletonSourcesFor`'s **order is the preference `fetchSkeletons` applies**, so
  "Automatic (published skeletons)" cannot name a route the fetch would not take — and
  `capabilitiesFor` is derived from that same list, short-circuiting only where a flat bucket
  already settles it, since it is asked about *every* capability on every graph mutation. **A
  pinned route the dataset lacks is an error, never a substitution** — the vocabulary half of that
  is `requireSkeletonRoute`, shared, because written per backend three of the five sources did not
  implement it at all. CAVE's service **generates on demand**, so
  `exists` is asked before any download (a cold GET is 10–45 s a neuron) and `automatic` takes it
  only when it covers *every* neuron — a scene mixing a reconstruction with a chunk decomposition
  is one where a number means two things. And neuPrint's published route resolves the
  **volume**, not the mesh directory: `optic-lobe:v1.1` keeps its meshes in a sibling, so the mesh
  answer looks one level too deep and concludes there are no skeletons.
  See [docs/backends.md](docs/backends.md) and [docs/nodes.md](docs/nodes.md).
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
- **Shape folds where colour cycles, and that asymmetry is the design.** `resolveShape` sits
  beside `resolveColor` in `src/ui/encoding.ts` and mirrors it — frequency ranking, `—` for a
  null, `Other`, overrides win — except for the tail: six marks, and everything past the sixth
  becomes a **dash**, which shares no silhouette with any of them. Cycling a hue is survivable
  (twenty of them, and the caption admits the repeat); a seventh category drawn as a second
  circle is a claim that two categories are the same thing. Sigma draws only discs, so
  `nodeShapeProgram.ts` replaces `@sigma/node-border` outright — its shader is `length()` at
  every setting — and three things there are silent when wrong: **sigma blends premultiplied**,
  so `vec4(rgb, a)` paints the whole vertex triangle in the border colour (a grey wedge behind
  every node, which reads as a geometry bug and is not one); the vertex quad inscribes
  `v_radius` while the marks are sized for equal *area* and reach 1.25, so `MARK_EXTENT` buys the
  headroom or corners get clipped — spent **per shape**, since a circle needs none and is the
  default; and the shader **flips `p.y`**, because `markVertices` is screen-space and sigma's
  graph y runs up, so the triangle — the only mark not symmetric about y — otherwise draws
  point-down on canvas and point-up in the legend and the export. The proportions live in
  `markGeometry.ts` and the **GLSL is generated from them**, not transcribed: a comment saying
  two languages agree is not an invariant, and `markGeometry.test.ts` is. The program module is
  **dynamically imported** because
  `sigma/rendering` touches WebGL globals at module scope and a static import takes every
  network test down with it. See [docs/viewers.md](docs/viewers.md).
- **A force simulation cannot lay out a graph that is mostly not connected, and the force law is
  not what fixes it.** Two components share no edge, so nothing in a simulation decides where one
  sits relative to the other. ForceAtlas2 answers by accident — its gravity draws every component
  into one well — and it gets **worse the longer it runs**: on a real 36k-node correspondence
  graph (11,936 components, largest 39) it scored 0.047 on neighbour purity after 25 iterations
  and 0.033 after a thousand, which took 115 seconds. Prefuse on the *whole* graph scores 0.009,
  below the thing it was brought in to beat. What wins is refusing the question: lay each
  component out alone and pack the boxes (`componentPack.ts`), which reaches 0.431 in half a
  second — past the naive grid packing (0.367) that was supposed to be the reference. It is now
  the **default** layout, which is what forced `prefuseRun`: the per-component yield cannot
  interrupt a *single* component and an ordinary connectome is one, so the simulation is
  resumable and sliced against the clock above 200 nodes — longest main-thread block 97ms at
  12,000 nodes, against 8s un-sliced. The annealing state rides on the run because it compounds;
  restarting it per slice re-heats the simulation and still draws something plausible. Cytoscape's "Prefuse Force Directed" does the same, which is
  the whole reason its output looked better. So `prefuseForce.ts` is faithful to prefuse's
  constants but the **`Components` param is the feature**; it departs from prefuse only where
  prefuse relies on `Math.random()` (a layout recomputed on every presentational edit must not
  wander) or on float precision running out (coincident points chain in a leaf instead of
  subdividing forever). The n-body sum is exact below 96 nodes, and the tree is pinned by
  reproducing the pairwise sum to 1.7e-15 at theta 0 — a tolerance at prefuse's own theta of 0.9
  would hide a structural bug inside the approximation's slack. Two traps: a separation test
  passes **without the feature** below about forty components, and `componentLabels` must keep
  agreeing with `networkOps.connectedComponents` or a node is coloured for one group inside
  another's box. See [docs/viewers.md](docs/viewers.md).
- **Two network colour modes cannot be columns, and that is why they are modes.** A node's
  connected component is derived from the link set; a link coloured by its upstream node resolves
  against the *node* table. `networkColor.ts` hands both to `resolveColor` as something it can
  already answer, so the palette rules stay in one place. Components are numbered largest-first
  so that ordering agrees with `resolveColor`'s frequency ranking by construction, and they are
  undirected — `networkOps.test.ts` asserts they agree with `expandSelection`'s component. An
  endpoint-coloured link reads the *resolved* node channel (overrides included) and draws **no
  legend**, because the node key already names every colour on screen.
  See [docs/viewers.md](docs/viewers.md).
- **The network's right-click menu borrows three things rather than writing them.** The rows and
  dismissal are `NodeContextMenu`'s; the "acts on the selection if you clicked into it" rule is
  `seedsFor`, shared with the drag; and the walk is `net.filter`'s `expandSelection`, which
  already knows that a component ignores arrows and that an undirected network's `source`/`target`
  are an arbitrary order. What is added is **node order** on the result, because it lands in an
  `ids` param that reaches a provenance key. Sigma routes a right-click to exactly one of
  node/edge/stage and the edge arm is gated on link count, so the browser's menu is cancelled on
  the *container*, not in the handlers. And `ViewerOverlay`'s capture-phase Escape had to stand
  aside for an open `.context-menu`, or the first press closes the viewer from under the menu.
  See [docs/viewers.md](docs/viewers.md).
- **Node dragging is five silent failures, not a mousemove handler.** Sigma ships none of it.
  `autoRescale` renormalises against the node extent on every refresh, so a drag must
  `setCustomBBox` first or the graph shrinks away under the cursor — and ⤢ must clear it again, in
  a `refresh` rather than a `setCustomBBox` alone. `preventSigmaDefault` is what stops the camera
  panning, and it is *also* why sigma still emits a click at the end (the captor's own drag counter
  sits after that check), so `clickNode` **and** `clickStage` need a tolerance of our own. The drag
  ends on the captor's `mouseup`, not `upNode`. A grab on a selected node moves the whole
  selection; positions are a delta from the grab, never a snap. Arithmetic in `networkDrag.ts`,
  headless; the gesture itself was driven in a real browser because nothing here is reachable from
  jsdom. Session-scoped through `layoutMemo`, never the document.
  See [docs/viewers.md](docs/viewers.md).
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

**Two functions, and which one you want is decided by the mark, not by taste.** `seriesColor`
folds everything past the eighth slot onto the achromatic `Other`; `cycleColor` comes round to
the first colour instead. The rule: **fold where the mark folds.** A bar, a slice, a histogram
segment and a box all *sum or drop* the tail into one shape, so that shape needs one colour and
grey is the honest one — `foldByRank` still governs them. A node, a point or a neuron keeps its
own mark whatever colour it gets, so folding bought nothing there and cost everything: fifty cell
types past the eighth became one grey lump meaning "not one of the eight". `resolveColor`'s
categorical branch cycles, which is Network, Scatter and 3D.

**Cycling's cost is real and is said out loud**, in the two places it can be: `+N more` on the
legend once there are more keys than `LEGEND_KEYS` (12) — on screen *and* in the exported SVG,
which used to run out of width in silence — and `colours repeat` in the caption, off
`CategoricalLegend.cycled`, the same admission `out.dendrogram` has always made.

**Five palettes, and only `coda` is validated here.** The other four are published sets
transcribed whole — Okabe–Ito (in R's eight-colour spelling, grey for the unusable black),
matplotlib's `tab10` and `tab20`, ColorBrewer's `Paired`. **The order is ours and only the
order:** `resolveColor` hands the leading slots to the commonest values, so `tab20` and `Paired`
are rotated to put their saturated halves first rather than the published dark/light
interleaving, which would spend the two most important slots on two shades of one hue. A
consequence worth knowing: `tab20`'s saturated half *is* `tab10`. The imported four are one set
for both themes, so the pale members are weak on the light surface — that is the price of the
capacity, and the param's help says so. Adding a sixth palette means transcribing a published
one, not mixing hues.

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
  correspondence graph, type-level edge comparison, neuron-level co-clustering — all built.
  Read before adding any node that puts two connectomes in one table: the qualified-id decision
  is recorded there, and so is the one thing that is **not** a port — `Cut Tree`'s mixed-dataset
  mode implements cocoa's stated goal rather than transcribing
  `extract_homogeneous_clusters`, and its criterion is written out for whoever compares them.
  Two rules about `Match Cell Types` that a reasonable change would break: **every
  correspondence is derived** (the `Synonyms` port was built and removed — a hand-written
  `A ↔ B` belongs in a downstream `Relabel`), and the one user assertion that *is* allowed —
  `Pass Through`, for a sex-specific type — is a **separate pass over what the matcher left
  empty**, never a relaxed `coversAll`. That test is asked in four places and each is
  load-bearing; exempting a component there lets one named label carry a whole component of
  unnamed ones past every gate. The report's `matched` column is what keeps a pass-through
  telling itself apart from a correspondence.
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
- [docs/analytics.md](docs/analytics.md) — the GoatCounter beacon: what it collects, the two
  gates that keep it off every build but the deploy, and why the canvas is not instrumented.
- [docs/ui-shell.md](docs/ui-shell.md) — panels, fullscreen and the manifest, the run
  indicator, the start page, keyboard shortcuts.
- [docs/pages.md](docs/pages.md) — overview, tutorial and node guide. Extra vite entries;
  each must stay out of the main chunk.
- [docs/help.md](docs/help.md) — the `?` on a node: the in-app overlay, the documents in
  `src/help/nodes/`, and the figures that draw real registry objects.

Two notes cut across all of them. **jsdom performs no layout and has no WebGL**, so anything
about geometry or pixels must be driven in a real browser. And **every measurement here was
taken, not estimated** — re-measure rather than reasoning one forward.
