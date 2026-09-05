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
pnpm format         # prettier, over src/**/*.{ts,tsx,css} and nothing else
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
   this keeps being re-broken: never `Number(...)` an id. And the transport grammar is not the
   only one: neuroglancer's `parseUint64` refuses a sign and a leading zero, which `isNeuronId`
   allows, so a scene goes through `isSegmentId` (`data/neuroglancer/scene.ts`) instead — a
   second predicate rather than a second spelling, because the two really do differ.

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
  **A peek whose fetch needs a credential is gated on having one**, and re-armed by the credential
  *changing*: `client.ts` refuses a tokenless CAVE request and fires `reportAuthFailure` as it
  does, so an ungated `peekDatastacks` puts "No CAVE token" in the status bar at somebody who has
  only dragged a node onto the canvas. A per-account listing is also not reusable across accounts.
  See [docs/backends.md](docs/backends.md).
- **A node whose output size is the product of two independently-resolved columns needs a
  ceiling checked before allocation** — neither picker knows what the other did.
- **A guard rail warns; it does not refuse.** A refusal claims there is no useful answer,
  which for a count is almost never true. `ctx.warn` is the channel; `CRASH_FLOOR_BYTES` is
  the only thing left that refuses, and only for an allocation. Time is never a refusal.
  See [docs/limits.md](docs/limits.md).
- **A param added to an existing node type has three states, and a card can only draw two.**
  `defaultParams` writes a default at *creation* and never runs over `deserializeGraph`, so a
  stored node without the key was written by a build that had no such control — not the same as
  the default, the moment absence means something *else*. `ParamBase.absentMeans` records the
  third state and `deserializeGraph` writes it in on load; deliberately not a general backfill.
  Other half of the trap: **a node with a body of its own draws no generic param rows**, and
  `compact` is always true for an on-canvas card, so gating on `!compact` means "inspector only".
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
  `location.pathname + location.search`; a share link carries the workflow in the *fragment*, so
  nothing leaks today — but that is a fact about sharing, not a promise, and one query param
  would turn workflow content into analytics data. `vite/goatcounter.ts` sends a literal per
  entry, derived from the filename so a fifth entry cannot arrive unlabelled. The tag is
  `apply: 'build'` **and** gated on `CODA_ANALYTICS`, set only in `deploy.yml`: this repo is
  public and permissively licensed, so without the second gate a fork's readers get reported to
  a dashboard its operator never chose. There is deliberately **no event tracking**.
  See [docs/analytics.md](docs/analytics.md).
- **A page whose content arrives with the script is a page most crawlers never read, and a
  sitemap does not fix it.** Google renders JavaScript; Bing's fast path, link unfurlers and the
  crawlers feeding language models do not. So `index.html` carries a `<noscript>` hero — **not**
  markup in `#root`, which `createRoot().render()` clears, charging every real visitor a flash of
  unstyled content to serve a crawler — and `nodes.html` a **visible** static index of every
  node's prose, built from the registry through `nodeGuideData`'s SSR server. Visible because
  hidden text keyed to a crawler is cloaking; the shared `SECTIONS` table is what stops it and the
  grid disagreeing. `vite/seo.ts` derives its page list from `build.rollupOptions.input`, the same
  rule `goatcounter.ts` follows. **`lastmod` is git's or absent, never a wall clock.** `SITE_URL`
  is deliberately **not** gated on an env var the way analytics is — the analytics gate protects a
  fork's *readers* from a third party, whereas a wrong canonical is contained within the fork.
  See [docs/seo.md](docs/seo.md).
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
- **Prettier owns `src/**/*.{ts,tsx,css}` and nothing else, and what it does *not* own is the
  half worth knowing.** `pnpm format` is the one declaration of that scope. Every `*.md` is
  outside it because prettier rewrites `*em*` to `_em_` throughout (687 diff lines in
  `docs/nodes.md` alone), burying the design records under emphasis churn, and `src/help/nodes/*`
  is the same prose read by the in-app `?`. The recorded `__fixtures__/*.json` are outside it
  because they are verbatim wire responses, worth diffing against the next recording. So
  `prettier --write .` is the wrong reflex: 111 files nobody asked for. CI enforces the scope by
  running `pnpm format` then `git diff --exit-code`, deliberately **not** a second
  `prettier --check` script — two spellings of one scope drift into a guard that passes while
  `pnpm format` still rewrites the tree, i.e. wrong in the passing direction. One documented
  exception goes the other way: a `<!-- prettier-ignore -->` pinning each
  `<meta name="description">` onto one line, because a wrapped tag is a tag `grep` reports
  missing. See [docs/seo.md](docs/seo.md).

Area-specific — the rule, then the doc that holds why:

- **A node's glyph is one drawing per type, and the table is data because a third surface has no
  React.** `ui/glyphs.ts`: 101 drawings on eleven base shapes — the base shape names the material,
  the drawing on top names the operation. Four marks are shared and load-bearing (funnel =
  filtering, dashed outline = a user's selection, four-point spark = "cleaned", weight = role).
  Colour is not a channel; `currentColor` only. Primitives rather than JSX because `nodes.html`
  draws the same set with no React. Three silent failures, all pinned by `glyphs.test.ts`: a
  mistyped key compiles and serves the category fallback; scaling a dataset silhouette scales its
  stroke (`specimenShapes` restores `GLYPH_STROKE_WIDTH`); the two renderers can disagree on
  `strokeWidth` vs `stroke-width`. See [docs/canvas.md](docs/canvas.md).
- **The canvas **+** unfolds rather than opening the browser, and every button in it is derived**
  from `nodeDefsByCategory` and `glyphs.ts`, so a node registered next month appears with no edit.
  A wrapping **band**, not a row (Transform holds 25 nodes); aligned to its button by measurement
  in a `useLayoutEffect`, since the button's position is `editor.css`'s arithmetic; `snakeRows`
  fills bottom-row-first in *order*, so DOM order stays alphabetical. Silent failures: a closed
  surface must be **unmounted, not hidden** (`visibility: hidden` drops a button from the tab order
  in a browser and from nothing under jsdom, so the test passes while asserting the opposite); the
  animation must be `@keyframes`, not a transition; `column-reverse` draws the first child last; a
  node button needs a fixed height and **no** border. Three from outside: the prefix is `fab-menu`
  because `add-menu` is the *command palette's*; `data-tour="add"` goes on the stack, not the
  button, because `tour.css` frees the spotlit element **and its subtree** — hence three tour steps
  on three surfaces; and the feedback nudge withholds itself off `addMenuOpen` rather than a
  `:has()` rule. See [docs/canvas.md](docs/canvas.md).
- **`defaultSize` sizes React Flow's _wrapper_, and only a viewer's card fills one**
  (`category: 'visualisation'`). Elsewhere it leaves the state bar hanging below the card. A
  node that only wants to be wider sets `NODE_BODIES[type].width`.
- **Two wires between the same pair of nodes are not a cycle.** `topoSort` derives indegree
  from the same index that decrements it, so the two cannot disagree again.
- **Copy is bound to the clipboard *events*, and a paste that is not a graph must fall through.**
  ⌘C/⌘X/⌘V ride `copy`/`cut`/`paste`, not keydown, because `clipboardData` is readable inside the
  browser's own gesture where `navigator.clipboard.readText` is a prompt in Chrome and a refusal in
  Firefox. `readFragment` therefore runs *before* `preventDefault` — most of what is on a clipboard
  is prose, and swallowing it is invisible from inside the app. A fragment is a graph file plus a
  marker, so a `.coda.json` pastes too; `duplicateSelection` is the same pair (`subgraphOf` +
  `insertFragment`) without the clipboard. A live text selection wins; a paste lands at a point the
  canvas supplies and **steps** on repeat. **Copy is live under the lock**; cut and paste are not.
  See [docs/canvas.md](docs/canvas.md).
- **A hint is docked to a card and dismissing it is not an edit.** `NodeHint` is a field on
  `GraphNode`, not a document-level list, so duplicate, copy/paste, `subgraphOf` and delete carry it
  free. It draws as a **sibling of `.coda-node`** (which clips), so `bottom: 100%` / `top: 100%`
  dock it with no measurement and no `ViewportPortal`. **Dismissal is `localStorage`, keyed on the
  hint's text** — in the document it would be an undo step, a dirty file, and a share link arriving
  pre-dismissed for the person being shown the workflow. Cost: reworded copy comes back for
  everybody and nothing is forgotten, hence **Show Hints** and **Show Hints Again**. Tone is a name
  off `HINT_TONES` over `markdown.ts`'s `CalloutTone`, held by a type-level assertion since `core`
  cannot import it. See [docs/canvas.md](docs/canvas.md) and [docs/wizard.md](docs/wizard.md).
- **A group frame is not a React Flow node — and a *folded* one is, the same argument reaching the
  opposite answer.** Expanded: `ViewportPortal` at `z-index: -1`, `pointer-events: stroke` on the
  rect alone (the interior must stay click-through), `nopan` because panning is d3-zoom's *native*
  listener; membership is node ids and the box is derived, since `parentId` would re-base positions
  five subsystems read absolutely. Folded, it is a box wires arrive at — which is what a node is —
  minted per render by `layout/collapse.ts`, declaring its own two ports, so `elkGraph.ts` never
  learns this feature by name. `collapsedView` is **one derivation with two readers**, the canvas
  and the ELK pass, or an arrangement gets made against invisible members. Exposed params
  (`GraphGroup.exposed`) are a **reference, never a copy** — same `ParamField`, same `setParam`;
  `validGroups`, `pruneGroups`/`createGroup` and `cloneGroups` (which **remaps**) are the three
  places that reference can stop naming something. Four silent failures, all browser-only: all-false
  `draggable`/`selectable`/`deletable` make React Flow **withhold the pointer**, and both symptoms
  read as features working — the drag panned the canvas, the right-click opened the palette
  (`style: { pointerEvents: 'all' }` restores it, and so does `CARD_POINTERS` inside `GroupPeek`);
  the multi-selection rectangle sits **over** the cards it surrounds and takes their events, so its
  rect is `pointer-events: none` or a right-click on a selected node opens the *browser's* menu, and
  it **includes hidden nodes**, leaving a draggable box over vacated canvas
  (`has-folded-selection` stands it down — falsifying `selected` instead strands a selection
  no pane click can clear); `GroupPeek`'s cards carry the same `data-id`s, so `measureCardSizes`,
  the port measurement and `spliceOn` must scope to `.canvas-area`; and its panel must stop **bare**
  keys or `d` opens the dashboard behind the dialog. `useAnyNodeState`/`useNodeStateCount` return
  **primitives** (invariant 7) — a running *count* re-renders the box on every 1→2→1, which a For
  Each does thousands of times. See [docs/canvas.md](docs/canvas.md).
- **`overflow-y: auto` clips the other axis too**, so a `Dropdown` holding a flyout submenu must
  pass `flyouts` to switch the panel's scroll off, or the submenu renders as a horizontal scrollbar.
  And **a shortcut's glyph is stored by meaning, not as text** — `src/ui/shortcuts.ts` is the one
  table, `formatChord` the only place that knows ⌘ from Ctrl, four surfaces read it, and
  `Editor.tsx` still owns the *bindings*. See [docs/ui-shell.md](docs/ui-shell.md).
- **A dialog that opens itself while a tour is running is a dialog nobody can use**, and an anchor
  that can fall back resolves before the thing it names exists. driver.js makes everything but the
  spotlit element `pointer-events: none`, so a modal arriving mid-step can be neither typed into nor
  dismissed. `SourcesPanel` asks `isTourActive()` and sends the message to the status bar instead,
  keeping `reason`; the tour asks for the token in a step of its own (`when`, `interactive`,
  `advanceWhen`, and an `after` that closes the panel — Next has to be a way out). Second half: an
  anchor with a `??` fallback resolves *instantly*, ending driver's `waitForElement` poll before
  React has committed, and the spotlight lands behind the dialog. **`TourStep.when` is asked once,
  at start**, because `go` indexes into the filtered list.
  See [docs/ui-shell.md](docs/ui-shell.md).
- **The Workflow Wizard replaced the bundled examples, and its option space is gated rather than
  offered.** Four questions — dataset, neuron selection, analysis, view — and `buildWorkflow`
  assembles the chain, each question narrowing on `capabilityAnywhere` and on what the analysis
  *produces*; `VIEWS` is that pairing **and** the node each pair ends on, one table read by both
  halves. The view question takes a **set**, stepped by `cardWidth`, because a viewer's height is
  its content and stacking overlapped on the first run. Four traps. **It asks the ceiling, not the
  floor**, since a wizard answer is a *family* with no dataset id yet — the floor hid Morphology and
  NBLAST for all three CAVE families; the ceiling names only keys that *vary*, the node still reads
  the floor so a real absence lands a message, and the test asserts both directions **per backend**.
  **`capabilityOf` answers `true` for an unregistered source**, so anything enumerating combinations
  at module-init or SSR time must `registerBuiltinSources()` first. **A generated search is capped**
  (`SEARCH_LIMIT`, auto-run being on; `GEOMETRY_LIMIT` on a morphology search, a skeleton node's
  `Limit` being a warn threshold, not a cap). And `demoWorkflow()` is what the tour's empty canvas
  and thirty test files load, so the suites exercise the graph that ships.
  See [docs/wizard.md](docs/wizard.md).
- **The launch sequence is one boolean and a stage, and the guides dialog is the first stop.**
  `startPageOpen` means the sequence is showing, `guidesOpen` that it is at its first stop, and
  `useLaunchStage` is the only place both are read — a second independent boolean would have taught
  the toolbar, the share link, `openZoo` and thirty tests about a modal they close today for free.
  Shown **once ever** (`coda.guidesSeen.v1`, written on *sight*, not on close). A guide taken from it
  returns to it, one from the `?` menu ends on the canvas — a closure flag, nothing the tour knows.
  A **checkmark means finished**: only `go` walking off the end sets it, since ×, Escape and every
  other `destroy` reach the same hook. See [docs/ui-shell.md](docs/ui-shell.md).
- **Small screens get a notice, not a layout, and it stands the guides dialog down.** A media query,
  not a UA string, asking **both axes** since a phone in landscape is wide; the numbers sit in the
  gap between every phone's short axis and the iPad mini's, and the test pins them against real
  device viewports through a parser that **throws** on a query shape it cannot read. Silent half:
  `GuidesDialog` returns null here, or mounting behind this spends a first visit's one appearance on
  a modal nobody saw. Invisible to every other `App` suite, since jsdom's `matchMedia` answers
  `false` to everything. The acknowledgement records **that** the reader answered, never the size;
  growing the viewport dismisses it and writes **nothing**.
  See [docs/ui-shell.md](docs/ui-shell.md).
- **A run notification is opt-in, but the tab title is not, and the fallback is the feature.**
  `Notification.requestPermission()` is refused outside a user gesture, so the bell's *click* is the
  prompt. **`denied` is terminal** — a page can never ask twice and hears nothing when the user
  relents, so the bell's pressed state is the stored preference **and** a live `notifyState()`.
  Three engines will never show one anyway (an uninstalled iOS Safari tab, Android Chrome's
  service-worker-only constructor, a refusal), so `flashTitle` runs unconditionally and captures the
  title it replaced **once**, or the tab says "Run finished" for the rest of the session. Away is
  `visibilityState` **or** `!hasFocus()`, because a covered window is still `visible`.
  See [docs/ui-shell.md](docs/ui-shell.md).
- **A second workflow is a second `Scheduler`, and a switch is `loadGraph` keeping the half it used
  to throw away** (*prototype*). The documents live in a `Map` beside the Scheduler; nothing else
  changed, because the document was already a value the store swapped. Four rules. **A Scheduler
  each, not one shared**: `newId` is unique within a *session* and `deserializeGraph` does not remap,
  so two documents from one file share node ids *and* provenance keys, and one cache would report
  the second copy as already run. **Freshness is derived**, so `refreshStates` on arrival recovers
  every badge with no run and no fetch. **The viewport is captured on `onMove`, not `onMoveEnd`** —
  a gesture-end never fires for a document only ever `fitView`ed, so switching leaves the outgoing
  transform on screen. **Every open route mints a document** (`openDocument` = `beginDocument` +
  `loadGraph`), reusing a blank *and historyless* canvas so a fresh visit strands no empty tab; that
  retired the replace-confirm outright, deleted rather than neutered, since a neutered `ask` leaves
  four surfaces rendering a flow no path can reach. **`newGraph` stays the in-place reset**
  twenty-three suites use; `newWorkflow` mints a document.
  See [docs/ui-shell.md](docs/ui-shell.md).
- **The open set survives a reload in two stores, and the split is about *when* the answer is
  needed.** The active document stays in the `localStorage` slot, because `loadAutosave` is read
  synchronously in the store's initialiser and `initialGraph` decides the first paint — an IndexedDB
  read there boots every visitor onto a blank canvas to serve the ones with four workflows open.
  Every *other* open document is `store/session.ts`, in IndexedDB, because the tail exceeds the
  5 MiB quota and `writeLocal` swallows the overflow, so the failure is an open set that silently
  does not persist. Four rules. **`loadActiveDocId` is `sessionStorage` and synchronous**, giving the
  slot's graph its identity in the same tick — without it a second `createDoc` **replaces** the live
  record rather than adding one, which keeps the row count right and stops a rename reaching the
  switcher, so the test asserts the rename. **The restore is additive and never activates**, so a
  share link followed before it lands is safe. **A document is written at the two moments its content
  can change** — its own autosave debounce, and once as it is switched away from. **A duplicated tab
  takes the whole set with it**: `watchTabIdentity`'s reclaim rewrites every open document, or the
  original reloads with one where it had four. Fifth, because the bounds differ: past `MAX_SLOTS` a
  tab loses its slot and keeps its session, and `loadAutosave`'s shared-key fallback then hands over
  another tab's graph — a recognisable degradation for one workflow and a *coherent-looking set with
  one foreign workflow in it* for several, so `fromSlot` says which answered and the restore takes
  its own copy back. Found at eight open tabs in a browser, not by reading the code. The autosave is
  also the one `serializeGraph` caller passing **`compact`**; byte-identity across paths was never a
  property, since every call stamps a fresh `modifiedAt`. Numbers: `pnpm probe:autosave-budget`.
  See [docs/persistence.md](docs/persistence.md).
- **A pinned viewer is a grid column, and one node is never live in two full-size surfaces.** `⇥`
  docks a viewer beside the canvas rather than over it, so `showPreview` stands the card down for
  `pinnedNodeId` exactly as for `expandedNodeId` — the same three WebGL contexts. The store refuses
  one id in *both*; two different nodes it allows. The canvas column is **`minmax(0, 1fr)`**, because
  React Flow's pane reports the whole graph's extent as its automatic minimum and a bare `1fr` pushes
  the dock off screen. The stored width is a **fraction** of the window under a **px** floor (the two
  clamp different things), and *which* node is pinned is deliberately not stored, because a node id
  means nothing in the next graph. See [docs/ui-shell.md](docs/ui-shell.md).
- **A dashboard cell is a reference to a node id, and the grid replaces the canvas rather than
  covering it.** `D` swaps `Editor` for `DashboardView` in the same grid area, so React Flow unmounts
  and every card's preview goes with it — the swap trades WebGL contexts rather than adding them.
  Hence **at most one cell per node, and only nodes that can be drawn**, enforced in `addCells` *and*
  `validDashboard` (a hand-edited file is the other way each arrives); `canHaveCell` is the one
  answer, `placeableIds`/`unplacedNodes` what the surfaces read. The dock does not render while the
  grid is up, being the one surface that could hold a node live beside a cell. **Order is position** —
  no `x`/`y`, flow is not `dense`, so a gap is visible rather than CSS reordering the list somebody
  just dragged. The **layout is in the document**, inverting the dock's rule on purpose: these ids
  belong to *this* graph. So does `DashboardLayout.open`, so a graph saved from the grid opens into
  the grid — kept invisible to anyone not using it by three rules: written **only when true**, a mode
  toggle **cannot mint a layout**, and it is **not an undo step**. Every dashboard action is **live
  under the lock**. The row height is **measured, not `1fr` and not `vh`** — `1fr` shortens every row
  as one grows, so the resize handle visibly does nothing, while `vh` is the window rather than what
  is left after four bits of chrome; `DashboardView` paints `--dash-row` onto the element, never into
  state. Last, and browser-only: **a cell is on screen before the run**, so the viewers that draw
  from their *inputs* (Explore, Profile, Topology, 3D, Neuroglancer, Metrics) read `nodeInputs` in
  `ViewerSurface` — memoised on the graph object and `previewVersion`, the two things a *run* does
  not move, a shared workflow then said "connect a table of neurons" beside a header reporting 401
  rows. **Not a better dep and not a memo**: `runVersion` buys back the same class of bug, and the
  memo was saving nothing. Two things not to undo — `previewVersion` is subscribed **ungated** here,
  where the card gates on `isViewer`, because a non-viewer node can hold a cell; and the test must
  run **underneath** a mounted grid, the one order that can see it.
  See [docs/dashboard.md](docs/dashboard.md).
- **A tolerated failure and a global alarm cannot be the same line.** `client.ts` reported every
  CAVE 401/403 to the channel that *opens the Connections dialog*, including the ones
  `runListing` was already catching — so a user with no access to one of the three specced
  datastacks got a dialog demanding a working token on every Run of a graph that ran fine. A
  request made speculatively, about something nobody asked for, carries `quiet` — **every peek
  included**, since `peekMaterializations` reaches the same record from a *render*; the backstop is
  that `runListing` reports **once** when nothing at all came back, and `refuseAuth` is the single
  site that decides, or three of the four had already drifted. And CAVE's listing filters
  with `ignore_tos=True`, so it names datastacks that then refuse — a listing longer than what
  works is the ordinary state of a new account, not a bug to design around. Second half:
  `missing_tos` is not a bad token, it carries the form that fixes it, and telling somebody to
  sign in again is telling them to do the one thing that cannot work. Third half, found by fixing
  the first two: **a tolerated refusal is still the answer to a question somebody will ask** —
  silencing the panel left the node pointed at that datastack saying `no dataset "(none)" on CAVE.
  Available: …` and listing the datasets that *did* answer. `DataSource.whyDatasetMissing` is
  where the listing's kept failures are read, synchronous so `validate` marks the card before a
  Run, and `undefined` there means *nothing is known* rather than *nothing is wrong*.
  See [docs/backends.md](docs/backends.md).
- **A message that names a remedy has to be reachable, and on a card nothing is.** React Flow puts
  `user-select: none` on every node, so an error naming the terms-of-service form that lifts it
  was a URL somebody had to retype by eye — `IssueText` is the one component the card, the
  inspector and the Connections alert render through, and the text carries `user-select: text`
  **and** `nodrag` (without the second, the drag that starts a selection moves the node). Its
  rule: **the visible text is the href**, because `authRefusal` reads that URL out of whatever
  deployment a Custom node points at and a mismatched label is the only thing an anchor can lie
  about; `http`/`https` only, so a server cannot write `javascript:` into an error body and have
  it linked. See [docs/ui-shell.md](docs/ui-shell.md).
- **A published token is not a credential, and shipping one makes a rotation a new failure mode.**
  Virtual Fly Brain publishes an `AnonymousUser` token per instance because CATMAID's query
  endpoints are POST-only and a browser satisfies neither of Django's CSRF gates. `publicTokens.ts`
  is a committed snapshot refreshed from their manifest in the background, and three of its rules
  exist because the obvious version fails silently. It **loses to a user's own token**, or a real VFB
  account's data disappears with nothing on screen to say why. A **401 drops it and retries** —
  `client.ts`'s loop stops at the first response it gets, so a rotated token would fail where an
  anonymous `GET` used to work; a token the *user* typed is never dropped. And the manifest is
  fetched `cache: 'no-cache'`, because it is served `immutable` with a one-year max-age and the
  refresh would otherwise run once per browser and then never again — presenting as the feature
  working. See [docs/catmaid_vfb.md](docs/catmaid_vfb.md).
- **A loop is one number in a hash, and the region is derived from the wires.** `For Each` has no
  sub-graph: `Scheduler.loopIndex` is folded into the begin node's provenance key, so advancing it
  re-keys every descendant and invariant 4 re-runs the region. Hence: the loop executes at the
  **last** node of its region; a settled loop does not re-run, so the index is left at `count - 1`
  rather than reset, while a **cancelled** loop needs `loopDone` to stop it settling half-processed;
  a `Collect` is the one node a cache hit must never answer for mid-pass; and `RunSummary.executed`
  is a set of node ids, so per-pass files come through the awaited `SchedulerHost.onIteration`,
  bounded by `loopNodes`. See [docs/loops.md](docs/loops.md).
- **A synaptic partner is usually not a neuron, and a node emitting an edge list has to say which it
  meant.** Connectivity matches its far end as a bare node — right for a weight total, wrong as the
  only option, since the great majority of partners on a real dataset carry no `:Neuron` label and
  nothing downstream can look them up. `Include fragments` is the control, off by default, and three
  rules hang off it. It is asked as a **`findNeurons` lookup per hop**, not as a clause compiled into
  five backends, so "published" means exactly what `Find Neurons` means on the same card and the
  `Neuron Set` port beside it cannot disagree; **seeds are exempt**, a body somebody pasted in not
  being a body to filter away; and it bounds the **frontier** as well as the rows, so a hop-2 result
  is not the unrestricted one with rows removed. `absentMeans: 'all'` — a stored graph queried every
  partner and keeps doing so. Both exporters already restricted the far end and had **always**
  silently disagreed with the canvas, so the new default is the text they already emitted and `all`
  is what needed writing. Last trap, invisible to a golden file: `Neuron Set` under full metadata is
  a **left join**, because `findNeurons` answers only about published neurons and a lookup keyed by
  an endpoint list comes back shorter than the list. See [docs/nodes.md](docs/nodes.md).
- **A synapse point cloud has to say what one row counts, and "min weight" was a confidence
  threshold.** Two bugs that hid each other. First: `synapsesCypher` wrote `s.confidence >=
  minWeight` against a **0..1** predictor score with the param an `int` floored at 1, so the
  *default* meant "perfectly confident only" and returned **no presynaptic site at all** on three
  datasets. It is `Min confidence` now, a `number` defaulting to **0**, inspector-only, with **no
  `max`, because there is no shared scale** (0..1 on neuPrint, a tracer's 1..5 on CATMAID,
  `cleft_score`'s few hundred on FlyWire). **Renaming the id is what carries stored graphs across** —
  `normalizeParams` reads only declared params, so an old `minWeight: 1` leaves the provenance key
  and absence falls to off; not `absentMeans`' case, since here absence and the default agree. A
  source that cannot honour it **warns** rather than dropping it. Second, hidden by the first: a
  neuPrint neuron holds one `SynapseSet` **per partner**, so the bare walk returns a T-bar once per
  partner it drives, and the surplus rows carry *nothing* distinguishing — they were weighting a
  multi-partner T-bar several-fold in syNBLAST and every density measure. `WITH DISTINCT n, s` is the
  fix and neuprint-python's own. It cannot simply always run, because **the three backends enumerate
  in different currencies and only one has a choice**: CAVE has no presynaptic site identity and
  CATMAID already answers one row per connector. Hence `Rows` is `skeletonParams.ts`' shape —
  `Automatic` plus the units the source declares in `DataSource.synapseUnits` (a **non-empty tuple**,
  so `[0]` always answers), a pinned unit it lacks an **error, never a substitution**, and
  `resolveSynapseUnit` reading both halves so the `Automatic (…)` label cannot name a unit the fetch
  would not take. Three departures from the skeleton control: a unit is a property of the
  **transport**, so the list is a static property and `validate` complains with no peek;
  **`SynapseRequest.unit` is required and resolved once, at the node**, so `fetchSynapses` has one
  door and a missing declaration is a compile error; and a **lone unit is not listed** as an option —
  which is the trap, since a graph pinned to a single-unit source's *own* unit then falls into the
  "chosen but unlisted" branch and is drawn unavailable while `validate` says nothing is wrong,
  unless that branch checks the served list first. The refusal sentence is **one function two layers
  render** (`synapseUnitRefusal`). There is deliberately **no third reader**: a `PointsValue` carries
  no unit, so nothing says which one answered after a run — the gap this stopped short of. Both
  exporters diverge in opposite directions now, each saying so.
  See [docs/nodes.md](docs/nodes.md) and [docs/backends.md](docs/backends.md).
- **A normalised weight is meaningless without its denominator, and there are two of them.** The
  Connectivity node's `Normalize` emits `weightTotal` beside `weightNorm`, because the same fraction
  means two different things over every partner and over partners labelled `:Neuron` — only a
  minority of a neuron's outputs reach a named neuron, against nearly all of its inputs. Three rules.
  The outgoing denominator is **`downstream`, never `pre`** (`pre` gives a plausible fraction many
  times too large); the totals query matches **`:Segment`** on the queried end, so a fragment gets a
  denominator rather than silence; and a missing or zero denominator is **null and counted**, never
  zero, because zero divides to an `Infinity` every chart draws off the top of the axis. Region split
  and restriction are one operation with the sum in a different place, so `minWeight` applies to the
  restricted connection **before** the split — turning the split on cannot change which partners are
  found. An attached edge set **removes** both capabilities where it *adds* `paths`: a file of
  `pre, post, weight` has no regions, and its weights are not the population the backend's totals
  count. See [docs/nodes.md](docs/nodes.md) and [docs/backends.md](docs/backends.md).
- **A path's denominator belongs to a population, and the floor that uses it has to prune while the
  search is still running.** `Paths` normalises with `Connectivity`'s vocabulary exactly, but a
  type-collapsed edge's weight is every LC4→PLP1 synapse summed, so its denominator is everything
  *every* PLP1 neuron receives. The frontier carries the type name, so a per-neuron total cannot
  answer it — hence `fetchGroupTotals` / `GROUP_TOTALS_SCHEMA`, a second method rather than a widened
  `fetchSynapseTotals` (whose key is an id read through `idText`), and a second predicate
  `canTotalGroups`, because the *method* is separately optional and a source carrying the flag
  without it must refuse before the run. Its type arm matches **`:Neuron`** where
  `synapseTotalsCypher` matches `:Segment`: a denominator counts the population its numerator came
  from. Four consequences. **Per hop, not once at the end** — that is the whole of what `Min
  fraction` buys, a denominator arriving after the search being able to rank what was found and not
  to change what was walked; the cache is asked per key. **`Rank by` is a control because the two
  weakest links are different steps** — the ranking inverts between metrics, so the bound, the
  neighbour order and the shortlist read the metric through **one** function, since a search bounded
  by one number and ranked by another prunes away its own answer and still returns something
  plausible. **An unmeasured connection is never dropped and never scored**: the floor lets a null
  fraction through, since a threshold deleting what it could not measure would report an absence as a
  decision; such a route ranks below every scored one, counted and warned about, and
  `RankedPath.bottleneckNorm` is `null` for it exactly as for a run that never normalised. And the
  Paths table carries `bottleneckNorm` with **no denominator column**, inverting `weightTotal`'s rule
  on purpose: a route's two bottlenecks are routinely different steps, so one column could name the
  denominator of neither — the Network output is where each fraction sits beside its own total. Both
  exporters refuse it: without a group denominator *and* `Min fraction` they walk a different graph.
  See [docs/nodes.md](docs/nodes.md) and [docs/backends.md](docs/backends.md).
- **A bounded influence score is the published one truncated, not an approximation of it — and the
  gain is the published `lambda_max` exactly.** `r = (I - gW)^-1 s` is the series `s + gWs + g²W²s +
  …`, so walking *H* hops and adding the terms *is* Bates et al.'s score stopped early. Every term is
  non-negative, which makes the answer a strict lower bound and turns all three losses — the unwalked
  tail, the frontier limit, the drive that reached a fragment — into numbers rather than caveats.
  With input-fraction weights W is row-stochastic, so the package's rescale *is* a per-hop factor and
  `Gain` is the same knob. **Which is why the default is 0.5 and not their 0.99**: a budget of *H*
  hops covers `1 - g^(H+1)`, and against the exact solve the low gain keeps nearly all of the score
  and almost all of the top 20 where 0.99 keeps little of either — their own docstring says 0.99
  amplifies the leading eigenmode a hundredfold, and that eigenmode belongs to the connectome rather
  than to anybody's seed. `syn_weight_measure='count'` is not implementable here at all: its scale
  factor is spectral. Four more rules. **The directions are not symmetric and the cheap one is the
  one people ask for** — `inputs` fetches the edges *and* their denominator and conserves mass
  exactly; `outputs` needs a second `synapseTotals` lookup and has no mass bound, and `propagate`
  throws rather than out-normalising. **It is not a BFS**: `W^k s` needs every neuron holding mass at
  hop *k* to spread it whether or not it spread at *k-1*, which is what puts recurrent loops in at
  all — so a neuron is *fetched* once and propagated from every hop, where `traverseConnectivity`
  skips an expanded node. **`Denominator` gates the modes** rather than being swapped per backend (two
  real Ws under one column name is `Normalize`'s refusal one layer up), defaulting to the traversal
  sum because `synapseTotals` is false on three of five sources. **Meeting in the middle buys fetch
  count, not depth** — unlike `pathOps` a one-ended run is already the whole answer, so the split is
  for `ball(A)+ball(B) << ball(A+B)`; `combineHalves` takes `(channelled, pooled, scored)` because the
  scored set is presynaptic upstream and postsynaptic downstream, and it reports no truncation bound,
  each half bounding its own series and the combined tail neither. The Python helper is checked by
  **running** it. See [docs/nodes.md](docs/nodes.md) and `src/help/nodes/neuron.influence.md`.
- **An aggregation's null rule is one decision made in three implementations, and they had drifted.**
  `Group By`'s `mean` divided by `bucket.n` — the *row* count — so a single null pulled it towards
  zero and the canvas, the exported notebook and the knitted document each said something different,
  while `pivotTable` in the same file has always kept its own `counts` array. `mean`/`min`/`max` now
  answer **null** for a group holding no number, where `0` was a manufactured measurement among real
  ones; `sum` still answers 0, which is the identity rather than a value. `countDistinct` no longer
  counts an absence, which is `join`'s rule a few lines away. The export half is **not symmetric**:
  pandas skips nulls by default and base R propagates them, so four of the seven need `na.rm = TRUE`
  in R — and `min`/`max` cannot use it, because over an all-absent group it answers **`Inf`** with a
  warning, a value that survives `is.na` and plots off the axis; those two are generated helpers. The
  goldens compare emitted *text*, so nothing in the suite could see any of this; the fixture now
  carries a second Group By purely so `probe-r-helpers.R` runs one.
  See [docs/nodes.md](docs/nodes.md).
- **`Normalize`'s guards were assumptions, and an empty line is not an unusable one.** `total > 0`
  and a maximum accumulated from `0` are correct for synapse counts and wrong for every signed
  matrix — and NBLAST, cosine and Pearson similarity are all routes to one. An all-negative matrix
  normalised to a grid of zeroes. The distinction that fixes it is between a line of *zeroes*, which
  is measured and stays zero, and a line that **holds values** and still totals zero or less, which
  has no fraction and comes out empty with a count said out loud. `max` takes the largest
  *magnitude*, identical wherever nothing is negative. See [docs/nodes.md](docs/nodes.md).
- **A per-seed channel is indexed by position, so the node deduplicates before anything reads it.**
  `propagate` sizes its channel array from `[...new Set(seeds)]` while `Influence` handed
  `influencePairs` and `combineHalves` the raw `idColumn`, so a repeat in the table shifted every
  channel past the first duplicate: one neuron's influencers filed under another's name, the last
  query missing, the surplus candidates `NaN`. A test has to use an **interleaved** repeat, because a
  set stacked onto itself is already aligned in its first *n* entries and hides it.
  See [docs/nodes.md](docs/nodes.md).
- **The Heatmap's row and column filters are one term each, and a pattern is opted into with `/`.**
  Explore's grammar, narrowed: a plain term is a case-insensitive substring, a leading `/` makes it a
  regex, `!` or `-` negates. `bareRegex` is **imported** from `neuronSearch.ts`, since where a pattern
  *ends* is the fiddly half. The opt-in is not taste: `SMP001(a)` compiled as a pattern matches
  nothing, which is why both exporters emit `regex=False` / `fixed = TRUE` for a literal — checked by
  running them. One term per axis, because two substrings ANDed against a short label is almost always
  empty. **An uncompilable pattern leaves that axis whole** (a half-typed `/^LC[` must not empty the
  picture) where **a filter matching nothing is honoured** and the result is empty. Filter runs
  *before* the sort, and both are one mechanism — a list of indices per axis through `takeMatrix`,
  which is also what `orderedMatrix` calls. See [docs/nodes.md](docs/nodes.md).
- **The Heatmap's Order tab is data and its Colour tab is not, and the split is the node.** The sort
  reorders the matrix the node *outputs*, so a Table beside the heatmap, the CSV and the notebook show
  what the card shows; those params are in the key and the tab says downstream nodes go stale
  (`paramGroups` with `affectsData`). Palette and scale are presentational and never re-fold the
  cells. Four rules. **The other axis follows by label, never by index** — an Adjacency is square and
  not symmetric, and "the same order" means the same neuron in row 3 and column 3. **The clustering is
  seaborn's clustermap, not Linkage's**: rows as vectors, distances between vectors,
  `coda_cluster_order` in `linkage.py` (numpy, not scipy — checked against `pdist` by `pnpm
  probe:heatmap-order`); Linkage reads the matrix *as* the distances, and each is wrong for the
  other's input. It is a Pyodide call inside a **`cheap`** node, on purpose. And a constant vector goes
  to **distance 1**, where scipy's NaN would refuse the whole matrix — both exporters write it that
  way. The palettes beside Coda's own are matplotlib's, **sampled by a script** and **not flipped with
  the theme**, so `cmap='viridis'` in the notebook is the picture on the card. `total` is the plain
  sum: the output cannot read a presentational param. See [docs/nodes.md](docs/nodes.md).
- **The heatmap's colour ends are manual-or-automatic and its log is on the colour alone.** One
  `colorDomain` decides a value's ramp position, so `normalize`, the per-cell `bucketScale`, the hit
  test and the SVG export cannot disagree. A limit is a **`string` param** because a `number` has no
  unset state (`NumberField` coerces back to the default) and `0` is an ordinary limit; an inverted or
  unreadable pair is **dropped whole**, since honouring half of it clamps every cell to one end.
  Out-of-range clamps and the caption admits it. **Diverging offers one end**, the magnitude of both
  arms, or the middle stops meaning zero. The log is `log1p(v − lo) / log1p(span)` — labels, tooltip
  and bar ends stay the values, the shift by `lo` is what makes it total on negative data, and it
  equals the exporters' `log10(1 + v)` because a ratio of logs is base-independent. It stays
  **monotonic**, so the fold's strongest-cell rule needed no case. seaborn's **`annot` takes a frame of
  its own** and ggplot gets a `fill_` column beside the untouched `value`: that is how the numbers stay
  raw under a transformed fill, and both were run. See [docs/viewers.md](docs/viewers.md).
- **The heatmap's zoom is a window in matrix units, and the window is what gets folded.** Not a scaled
  canvas: scaling keeps the fitted fold's blocks and enlarges them, and scales the labels, which is the
  one thing they must not do. `HeatmapWindow` goes into `buildHeatmapSpec`, so zooming in folds *fewer*
  cells and past 1:1 real cells appear with their own labels, re-thinned for the pitch. Per-axis
  `AxisMap`s carry a grid origin *before* the plot's edge, so both renderers clip to three zones
  (`TextMark.zone`). The colour domain is memoised apart from the window — a pan must not rescan, a
  zoom must not recolour — and matrix units are why a resize keeps the zoom. Two browser-only findings:
  **the canvas raster is not in any `performance.measure`** (batched rectangles recorded in 8 ms and
  cost the frame 250 ms), so the cells are an `ImageData` blitted with smoothing off and the paths are
  the SVG export's alone; and **an interior line's visible extent equals its pitch only up to
  rounding**, so the sliver test carries a tolerance or a third of the labels vanish at random.
  See [docs/viewers.md](docs/viewers.md).
- **The dendrogram's zoom is a window along the *leaf* axis only, and that asymmetry is the finding.**
  The gestures are `HeatmapViewer`'s exactly, and like its zoom this is an **input to the drawing
  rather than a transform over it** — a scaled bracket takes its labels with it. So `visibleLeaves`
  re-thins names for the pitch and `visibleLinks` drops what the window cannot reach, returning
  `shape.links` **by identity** at the fit so an unzoomed card pays nothing. **Two axes was built first
  and is wrong in a way only a browser shows**: a dendrogram's leaf axis is a list and its distance
  axis is the *measurement*, so zooming about a pointer part way up it moves the window off the leaves
  — readable names beside two brackets and an acre of empty card, the merges you zoomed in to see being
  exactly what leaves. Holding the distance axis whole also makes two zoom states comparable and keeps
  the root's crossbar on screen; the case the other version served wants a log scale, not a zoom. Its
  price is that **a drag along the distance axis does nothing**, by construction. Three rules exist
  only because this viewer's purpose is *clicking* branches: **pan runs only while zoomed**;
  **`draggedRef` is a ref, not state**, or `pick`'s identity changes and every bracket re-reconciles on
  each pointer move; and **pointer capture is taken at the slop, not at the press**, because capturing
  from `pointerdown` sends the `click` to the capturing element and selection silently stops working
  the moment anybody zooms in. The wheel is **`useWheelZoom`**, shared with the heatmap. Everything the
  window feeds is **memoised** — `clampWindow` mints a fresh object and the window is a prop of the
  memoised `DendrogramLinks`, so an unmemoised one fails the shallow compare on every `setHover` and
  voids `visibleLinks`' by-identity return. Two more from the browser: a pan drags across leaf labels
  and **selects** them (`user-select: none` while panning only), and the gutter clips **along the leaf
  axis only** or every label is erased. See [docs/viewers.md](docs/viewers.md).
- **A dendrogram leaf's *name* is a drawing and its *label* is the identity, and the Annotations port
  only ever touches the first.** On every route into Linkage but NBLAST's a leaf is a bare root id, so
  `out.dendrogram`'s `Annotations` port takes an ordinary table and `Match on`/`Label by` join it onto
  the leaf's own label — `displayLabels`, headless in `nodes/lib` so an exporter reads the same rule
  the viewer does. **`evaluate` never reads it** and both pickers are `presentational`, which is the
  whole design: `Selected.label` is what `cluster.selectedToNeurons` matches against a neuron table, so
  a tree renamed by cell type turns one clade into every neuron of those types — plausible, wrong, and
  nothing raises it. What is bought is that trying `type`, then `instance`, then `hemilineage` changes
  no provenance key and re-runs no `expensive` Linkage. Both pickers are **`optional`** for a sharper
  reason than taste: `resolveColumn`'s rule 3 substitutes the *first compatible column* for a required
  picker whose default the schema lacks, which here would name every leaf after whatever column comes
  first. **The join is `labelsByNeuron`**, so its rules come with it: a blank is no label, the first
  non-blank row wins a repeated id, and ids go through `idText` — which drops an already-rounded wide
  id (invariant 8) instead of naming whichever neuron owns the rounded value, a case that presents
  *identically to an unwired port* and is what the `validate` line exists for. An **unnamed leaf keeps
  its own label**, inverting `core.relabel`'s `Unmatched` default because a blank leaf is worse than
  the id it replaced; the caption counts them. The identity moves to an SVG `<title>` in a `<g>`
  **beside** the `<text>`, not inside it. **The Heatmap deliberately gets no such port**: its row
  labels are *data*, matched by the Filter tab and sorted by the Order tab, so a presentational rename
  there shows `LC4` while a filter typed `LC4` matches nothing. Last trap, found by **running** the
  emitted cell: pandas' `dropna` keeps the empty string, so an untyped body drew a blank leaf in the
  notebook where the canvas drew its id — **the join the emitters do is `coda_relabel`**, the helper
  `core.relabel` already emits, because hand-rolling it on `.astype(str)` matches *nothing* when an
  `i64` column with one null becomes `float64` and prints `'101.0'`.
  See [docs/viewers.md](docs/viewers.md).
- **The graph metrics are two nodes because `cost` is a property of a node type.** `net.metrics` is
  `cheap` and every measure on it is O(V + E); `net.centrality` is `expensive` and runs only on Run.
  One node holding both would have to be `expensive`, and then reading a graph's node count and density
  would need a Run. They compose: Centrality writes its columns onto the network. Four rules, each of
  which the obvious version gets wrong. **A self-loop counts towards degree and towards nothing else**
  — it cannot close a triangle, cannot join two components, and in density would let a graph exceed 1 —
  so every structural measure runs on the undirected simple projection; that is also where Coda and
  networkx part company, and *both* places it bites were found by running the emitted helpers
  (`overall_reciprocity` divides by every edge, `eigenvector_centrality` keeps loops, so one heavy
  autapse scores 1.0 while every real hub rounds to zero). The metric columns are written **over** the
  ones a network already had, never beside, because `degreeIn_1` next to `degreeIn` gives a picker two
  answers and the second is the stale one. **Sampling estimates a mean and refuses to estimate a
  maximum**: `meanPathLength` is scaled, `diameter` is null, a sampled maximum being a lower bound with
  no error bar. And **parallel links are merged, summing weights, before any path is counted** —
  Brandes adds `sigma` once per copy, so four rows for one pair inflate every betweenness downstream
  with nothing looking unusual. Numbers are pinned against networkx by a checked-in fixture and the
  exporters by `pnpm probe:netexport`. One trap in the wiring: **`networkMetrics` is memoised and the
  card calls it too**, from the node's input — so a warning raised *inside* it goes to whichever caller
  arrived first, which on the ordinary chain is the card, with no warner. The cost and the drop count
  ride on the result and `evaluate` warns from them, which is `out.describe`'s arrangement.
  See [docs/nodes.md](docs/nodes.md), [docs/viewers.md](docs/viewers.md) and
  [docs/export.md](docs/export.md).
- **A dataset-level filter is not a filter row, the row wins, and the filters OR.** The population
  checkboxes on a neuPrint dataset node are **OR-ed** — a second ticked box lets *more* rows through.
  `typed` matches column names **ending** in `type`. `findNeuronsCypher` drops the `traced` disjunct
  when a filter row names `status`, and all four emitter spellings repeat that. Defaults are per
  **family**. Which queries they reach is `neuronSetRequest`, kept separate from `datasetRequest`:
  never a lookup by id, and never the far end of a `ConnectsTo` **except** through Connectivity's
  `Include fragments`. The neuron index is cached whole and narrowed on load. And a schema that has not
  arrived is not a schema without these columns — compare `discoveredNeuronSchema` by **identity**
  before greying a box. See [docs/datasets.md](docs/datasets.md).
- **An edge list is not a skeleton.** `SkeletonGeometry.parents` is a rooted tree in *visit order*,
  built from an undirected graph that may hold cycles and disconnected components. `spanningForest`
  (`src/data/skeletonTree.ts`) is the one walk; a surviving cycle makes every consumer that walks to a
  root loop forever. See [docs/backends.md](docs/backends.md).
- **Two ways a mesh source resolves to somewhere with no meshes in it**, both reported as neurons that
  have none. `@type` is optional on a precomputed volume, so `isVolumeInfo` — not a `switch` on
  `@type` — is the one predicate `openMeshSource` and `probe.ts` ask. And a graphene manifest is not
  all shards: it mixes shard reads with plain objects under `mesh_metadata.unsharded_mesh_dir`, so the
  neuron arrives whole minus every piece anyone has edited. `fragmentUrl` matches on `.shard:`.
  See [docs/backends.md](docs/backends.md).
- **A skeleton is not one product, and which route answered is a fact about the *value*.** A dataset
  usually has more than one place to get one from, and cable length means something different down
  each — so `SkeletonsValue.provenance` rides on the value and the Skeletons node's `Source` is where
  you choose. Four rules, each load-bearing: `DataSource.skeletonSourcesFor`'s **order is the
  preference `fetchSkeletons` applies**, so "Automatic (published skeletons)" cannot name a route the
  fetch would not take — and `capabilitiesFor` is derived from that same list, short-circuiting only
  where a flat bucket already settles it, since it is asked about every capability on every graph
  mutation. **A pinned route the dataset lacks is an error, never a substitution**, whose vocabulary
  half is the shared `requireSkeletonRoute`, because written per backend three of the five sources did
  not implement it at all. CAVE's service **generates on demand**, so `exists` is asked before any
  download and `automatic` takes it only when it covers *every* neuron — a scene mixing a
  reconstruction with a chunk decomposition is one where a number means two things. And neuPrint's
  published route resolves the **volume**, not the mesh directory, or the mesh answer looks one level
  too deep and concludes there are no skeletons.
  See [docs/backends.md](docs/backends.md) and [docs/nodes.md](docs/nodes.md).
- **A CAVE sign-in is a popup and a `postMessage`, and every hard part is a silent ending.**
  `middle_auth` is itself the OAuth client — it holds Google's secret and owns the redirect URI — so
  its callback page posts `{token, app_urls}` to `window.opener` with target origin `"*"`: nothing to
  register, no secret to ship, and a static deploy can therefore sign somebody in. Four consequences.
  The login prefix is **read from `/auth_info`** and never assumed. The window is opened **blank,
  before** the lookup that points it, because one opened after an `await` is outside the click and gets
  blocked. A message is a token only when `source` is the window we opened **and** `origin` is the
  service discovered before opening it — the terms-of-service arm posts the bare string `"success"`,
  and `"*"` cuts both ways. And **the paste field stays**, for the exits that hand nothing back: a
  blocked pop-up, and middle_auth's own error pages. A **first login is not one of them** — it is
  diverted to a "choose a username" form that *does* deliver and creates the account as it goes, so the
  first-run failure to expect is a 403 on a datastack after a sign-in that worked. What is stored is
  the login token plus a **label, not an expiry** — the 401 is the only thing that knows, and
  `create_token` would instead put a permanent credential in `localStorage`. **neuPrint cannot do any
  of this**, which is a fact about DatasetGateway rather than a gap to work around.
  See [docs/backends.md](docs/backends.md).
- **CAVE's row cap is a per-deployment number, and a reference table has no root id.** `CAVE_MAX_ROWS`
  is one server's `QUERY_LIMIT_SIZE`, so truncation is tested against the server's own `COUNT`
  (`countTable`), never the constant and never with `>=`. A `cell_type_reference` table carries
  `target_id` and no root id: reading one means the *join* endpoint, which takes `select_column_map`
  and only that, and ignores `count=true`. Both failures read as facts about the data.
  See [docs/backends.md](docs/backends.md).
- **A thumbnail is not always a mesh.** `CoarseGeometry` is a union and `kind` is required on both
  arms — a source that omits it silently falls through to the mesh branch and draws a blank tile.
  CATMAID skeletons carry no byte ceiling on purpose, and both rasterisers in
  `src/ui/explore/thumbnail.ts` share one `fitToTile`. See [docs/widgets.md](docs/widgets.md).
- **The fat-line path is four shader patch sites that must agree, and a patch that stops matching is
  silent.** `SkeletonGeometry.radii` is filled by all three skeleton backends; three's `LineMaterial`
  takes one `linewidth` uniform, so `flexLineMaterial.ts` rewrites three's own shaders — vertex *and*
  fragment for the world-unit (`to scale`) mode, or the box and its silhouette disagree. It **throws
  rather than falling back**, because a `ShaderLib` rename compiles fine and draws every skeleton at
  the uniform width; `flexLineMaterial.test.ts` runs the patch. Three numbers are load-bearing: scale
  against the **p95** radius, never the maximum; keep the 1px floor (`MIN_WORLD_PIXELS` per vertex via
  `abs( clip.w )`, since a floor cannot be a number of nanometres); and three's `rayEnd … * 1e5` is
  exactly 100 µm in a nanometre scene, past which *every fragment discards* and the arbour vanishes
  whole in one zoom step. See [docs/viewers.md](docs/viewers.md).
- **Shape folds where colour cycles, and that asymmetry is the design.** `resolveShape` mirrors
  `resolveColor` — frequency ranking, `—` for a null, `Other`, overrides win — except for the tail: six
  marks, and everything past the sixth becomes a **dash**, which shares no silhouette with any of them.
  Cycling a hue is survivable; a seventh category drawn as a second circle is a claim that two
  categories are the same thing. Sigma draws only discs, so `nodeShapeProgram.ts` replaces
  `@sigma/node-border` outright, and three things there are silent when wrong: **sigma blends
  premultiplied**, so `vec4(rgb, a)` paints the whole vertex triangle in the border colour (a grey
  wedge that reads as a geometry bug and is not one); the vertex quad inscribes `v_radius` while the
  marks are sized for equal *area*, so `MARK_EXTENT` buys headroom or corners get clipped — spent **per
  shape**, a circle needing none; and the shader **flips `p.y`**, because `markVertices` is
  screen-space and sigma's graph y runs up, so the triangle otherwise draws point-down on canvas and
  point-up in the legend. The proportions live in `markGeometry.ts` and the **GLSL is generated from
  them**, not transcribed. The program module is **dynamically imported**, because `sigma/rendering`
  touches WebGL globals at module scope and a static import takes every network test down with it.
  See [docs/viewers.md](docs/viewers.md).
- **A force simulation cannot lay out a graph that is mostly not connected, and the force law is not
  what fixes it.** Two components share no edge, so nothing in a simulation decides where one sits
  relative to the other. ForceAtlas2 answers by accident — its gravity draws every component into one
  well — and it gets **worse the longer it runs**. What wins is refusing the question: lay each
  component out alone and pack the boxes (`componentPack.ts`), which on a real 36k-node graph beat both
  ForceAtlas2 and the naive grid packing that was meant to be the reference. It is now the **default**
  layout, which is what forced `prefuseRun`: the per-component yield cannot interrupt a *single*
  component and an ordinary connectome is one, so the simulation is resumable and sliced against the
  clock above 200 nodes. The annealing state rides on the run because it compounds; restarting it per
  slice re-heats the simulation and still draws something plausible. So `prefuseForce.ts` is faithful
  to prefuse's constants but the **`Components` param is the feature**; it departs from prefuse only
  where prefuse relies on `Math.random()` (a layout recomputed on every presentational edit must not
  wander) or on float precision running out. The n-body sum is exact below 96 nodes, and the tree is
  pinned by reproducing the pairwise sum at theta 0 — a tolerance at prefuse's own theta of 0.9 would
  hide a structural bug inside the approximation's slack. Two traps: a separation test passes
  **without the feature** below about forty components, and `componentLabels` must keep agreeing with
  `networkOps.connectedComponents` or a node is coloured for one group inside another's box.
  See [docs/viewers.md](docs/viewers.md).
- **Two network colour modes cannot be columns, and that is why they are modes.** A node's connected
  component is derived from the link set; a link coloured by its upstream node resolves against the
  *node* table. `networkColor.ts` hands both to `resolveColor` as something it can already answer, so
  the palette rules stay in one place. Components are numbered largest-first so that ordering agrees
  with `resolveColor`'s frequency ranking by construction, and they are undirected. An
  endpoint-coloured link reads the *resolved* node channel (overrides included) and draws **no
  legend**, because the node key already names every colour on screen.
  See [docs/viewers.md](docs/viewers.md).
- **The network's right-click menu borrows three things rather than writing them.** The rows and
  dismissal are `NodeContextMenu`'s; the "acts on the selection if you clicked into it" rule is
  `seedsFor`, shared with the drag; and the walk is `net.filter`'s `expandSelection`, which already
  knows that a component ignores arrows and that an undirected network's `source`/`target` are an
  arbitrary order. What is added is **node order** on the result, because it lands in an `ids` param
  that reaches a provenance key. Sigma routes a right-click to exactly one of node/edge/stage and the
  edge arm is gated on link count, so the browser's menu is cancelled on the *container*. And
  `ViewerOverlay`'s capture-phase Escape had to stand aside for an open `.context-menu`, or the first
  press closes the viewer from under the menu. See [docs/viewers.md](docs/viewers.md).
- **Node dragging is five silent failures, not a mousemove handler.** Sigma ships none of it.
  `autoRescale` renormalises against the node extent on every refresh, so a drag must `setCustomBBox`
  first or the graph shrinks away under the cursor — and ⤢ must clear it again, in a `refresh` rather
  than a `setCustomBBox` alone. `preventSigmaDefault` is what stops the camera panning, and it is
  *also* why sigma still emits a click at the end, so `clickNode` **and** `clickStage` need a tolerance
  of our own. The drag ends on the captor's `mouseup`, not `upNode`. A grab on a selected node moves
  the whole selection; positions are a delta from the grab, never a snap. Arithmetic in
  `networkDrag.ts`, headless; the gesture itself was driven in a real browser because nothing here is
  reachable from jsdom. Session-scoped through `layoutMemo`, never the document.
  See [docs/viewers.md](docs/viewers.md).
- **A post-processing pass moves the background out from under the scene, twice.** An `EffectComposer`
  renders into a texture, so the canvas colour needs `scene.background` (not the clear colour, which
  `RenderPass` sets before binding the target) and `<Canvas flat>` (tone mapping is per-*image* through
  a composer, not per-material). Four more seams it owns: `setSize` takes **CSS pixels**; the PNG
  export renders its own frame and must go through the chain; `_overrideVisibility` misses fat lines (a
  `Mesh` carrying `isLineSegments2`), which is what `hidesFromGtao` is for; and **both** world-unit
  uniforms are rescaled, `radius` *and* `thickness` — a library's world-unit defaults agree with each
  other, so rescaling one is a different kind of broken rather than a partial fix. Strength is one
  slider where 0 is off, not a toggle plus a strength. And **a `useMemo` may be reused across a remount
  while an effect cleanup always runs**, so return the pass from the memo rather than writing it into a
  ref. Render an effect's own buffer before explaining why it looks weak, and measure on a real GPU —
  headless Chrome falls back to SwiftShader. See [docs/viewers.md](docs/viewers.md).
- **Restoring `layers` in the embedded neuroglancer is not safe under the pointer, and one bad id is
  not one bad id.** A layer is constructed — subscribing to the hover machinery — a whole loop before
  it is initialised, which is where `selectionState` is assigned, and neuroglancer never disposes that
  subscription. So any layer that dies in between answers `undefined.generation` on every mouse
  movement for the life of the document, which is why the crash surfaces on `mouseout` rather than on
  the edit. Two ways in, both closed: an update is **held until `mouseleave`** on `.ng-frame`
  (replacements too, but never the opening navigation), and every segment id goes through
  **`isSegmentId`** — `parseUint64`'s own grammar, narrower than `core/ids.ts`, since a miss deletes the
  layer rather than the id. That filter is in **`buildScene`**, not in the node, because
  `NeuroglancerProfileFrame` is the other caller; the node filters *again* only so it can count and
  `ctx.warn`. Third rule, and why none of this reproduces in production: **`proxiedViewer` says a
  prefix is declared, not that anything serves it** — `/ng` is a path on *this* origin, so a static
  deploy 404s instead of degrading, and `sameOriginViewer` gates it on `import.meta.env.DEV`.
  See [docs/viewers.md](docs/viewers.md).

## Chart colours

Do not pick chart colours by eye. The palette in `src/ui/colors.ts` was validated with the
`dataviz` skill's validator; the header comment records what passed and what didn't. If you
change the palette, re-run the validator; don't reason about ΔE.

The load-bearing finding: **only three chromatic families clear the all-pairs colourblind-safety
gate on the dark surface**, which is why socket types are distinguished by colour _plus shape plus
a visible label_. A fourth socket hue from these ramps fails the normal-vision floor.

`CHART_INK.grid` is for chrome only — under the 3:1 non-text floor, i.e. invisible by design.
Anything carrying data (network links and their arrowheads) takes `muted` instead, which is
achromatic so it never competes with a categorical encoding.

**Two functions, and the mark decides which — not taste.** `seriesColor` folds everything past
the eighth slot onto the achromatic `Other`; `cycleColor` comes round to the first colour instead.
The rule: **fold where the mark folds.** A bar, a slice, a histogram segment and a box all *sum or
drop* the tail into one shape, so that shape needs one colour and grey is the honest one
(`foldByRank` governs them). A node, a point or a neuron keeps its own mark whatever colour it
gets, so folding bought nothing and cost everything — fifty cell types past the eighth became one
grey lump meaning "not one of the eight". `resolveColor`'s categorical branch cycles: Network,
Scatter and 3D. **Cycling's cost is said out loud** in the two places it can be: `+N more` on the
legend past `LEGEND_KEYS`, on screen *and* in the exported SVG (which used to run out of width in
silence), and `colours repeat` in the caption off `CategoricalLegend.cycled`.

**Five categorical palettes, and only `coda` is validated here.** The other four are published sets
transcribed whole — Okabe–Ito (R's eight-colour spelling, grey for the unusable black),
matplotlib's `tab10` and `tab20`, ColorBrewer's `Paired`. **The order is ours and only the order:**
`resolveColor` hands the leading slots to the commonest values, so `tab20` and `Paired` are rotated
to put their saturated halves first rather than the published dark/light interleaving, which would
spend the two most important slots on two shades of one hue. (`tab20`'s saturated half *is*
`tab10`.) The imported four are one set for both themes, so the pale members are weak on the light
surface — the price of the capacity, and the param's help says so. Adding a sixth palette means
transcribing a published one, not mixing hues. The heatmap's `HEATMAP_SEQUENTIAL` and
`HEATMAP_DIVERGING` follow the same rule: matplotlib's, generated by a script, stop count measured
rather than chosen (see [docs/viewers.md](docs/viewers.md)).

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
  capabilities on it. Read before adding a Python-backed one: all seven declare the same two
  packages, which is the finding rather than a coincidence.
- [docs/persistence.md](docs/persistence.md) — share links, the autosave across tabs, the
  browser shelf.
- [docs/wizard.md](docs/wizard.md) — the Workflow Wizard: the option space, what removing the
  bundled examples cost, and the three numbers a generated graph carries. Read before changing
  what it can build.
- [docs/zoo.md](docs/zoo.md) — the Coda Zoo, and why its index is a committed file rather
  than an API listing. Read before changing `ZooIndex`.
- [docs/analytics.md](docs/analytics.md) — the GoatCounter beacon: what it collects, the two
  gates that keep it off every build but the deploy, and why the canvas is not instrumented.
- [docs/seo.md](docs/seo.md) — being found: the static content two pages needed before a sitemap
  was worth anything, the per-page tags, and why `SITE_URL` is *not* gated the way analytics is.
- [docs/ui-shell.md](docs/ui-shell.md) — panels, fullscreen and the manifest, the run
  indicator, the start page, keyboard shortcuts.
- [docs/dashboard.md](docs/dashboard.md) — the grid view: the cell model, the mode that unmounts
  the canvas, the two gestures and what was measured in a real browser.
- [docs/pages.md](docs/pages.md) — overview, tutorial and node guide. Extra vite entries;
  each must stay out of the main chunk.
- [docs/help.md](docs/help.md) — the `?` on a node: the in-app overlay, the documents in
  `src/help/nodes/`, and the figures that draw real registry objects.

Two notes cut across all of them. **jsdom performs no layout and has no WebGL**, so anything
about geometry or pixels must be driven in a real browser. And **every measurement here was
taken, not estimated** — re-measure rather than reasoning one forward.
