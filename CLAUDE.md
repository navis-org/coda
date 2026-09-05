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
- **A page whose content arrives with the script is a page most crawlers never read, and a sitemap
  does not fix it.** Google renders JavaScript; Bing's fast path, every link unfurler and every
  crawler that feeds a language model do not — and for a tool nobody has heard of that last group
  is a discovery channel, not a footnote. So the two pages that had nothing in the file got
  something: `index.html` a `<noscript>` hero (**not** markup in `#root` — `createRoot().render()`
  clears it, so that is a flash of unstyled content charged to every real visitor to serve a
  crawler), and `nodes.html` a **visible** static index of every node's prose, built from the
  registry through `nodeGuideData`'s existing SSR server. Visible because hidden text keyed to a
  crawler is cloaking; the shared `SECTIONS` table is what stops it and the grid disagreeing.
  `vite/seo.ts` does the rest — and derives its page list from `build.rollupOptions.input`, the
  same rule `goatcounter.ts` follows, so a fifth entry cannot arrive with no canonical and no
  sitemap row. **`lastmod` is git's or absent, never a wall clock**: restamping four pages every
  deploy is how a sitemap stops being read. And `SITE_URL` is deliberately **not** gated on an env
  var the way analytics is — the analytics gate protects a fork's *readers* from a third party,
  whereas a wrong canonical is contained entirely within the fork.
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
  outside it because prettier rewrites `*em*` to `_em_` throughout — 687 diff lines in
  `docs/nodes.md` alone — which would bury the design records under emphasis-marker churn, and
  `src/help/nodes/*` is the same prose read by the in-app `?`. The recorded
  `__fixtures__/*.json` are outside it because they are verbatim wire responses, worth being
  able to diff against the next recording. So `prettier --write .` is the wrong reflex: it
  reformats 111 files nobody asked it to, of which the only ones it would help are the ten
  under `scripts/`. CI enforces the scope by running `pnpm format` and then
  `git diff --exit-code`, deliberately **not** a second `prettier --check` script: a check
  script repeats the glob, and two spellings of one scope drift into a guard that passes while
  `pnpm format` still rewrites the tree — wrong in the passing direction, which is worse than
  absent. One documented exception lives the other way round, a `<!-- prettier-ignore -->`
  pinning each `<meta name="description">` onto one line, because a wrapped tag is a tag
  `grep` reports missing. See [docs/seo.md](docs/seo.md).

Area-specific — the rule, then the doc that holds why:

- **A node's glyph is one drawing per type, and the table is data because a third surface has no
  React.** `ui/glyphs.ts` is 101 drawings on eleven base shapes — *a base shape names the
  material, the drawing on top names the operation*, which is what makes Filter, Sort and Sample
  read as one family before the label does. Four marks are shared and load-bearing: the **funnel**
  is filtering (`core.filterTable` **and** `net.filter` — same verb, different material), a
  **dashed outline** is a selection the user made, the **four-point spark** is "cleaned", and
  **weight says role** in a node-link drawing. Colour is *not* a channel here; `currentColor`
  only, because the category tint is already spent on the header strip and the pip. It is
  primitives rather than JSX because `nodes.html` draws the same set as strings and has no React
  in its bundle — it kept a hand-written copy of the six category glyphs, which was fine at six
  and 101 chances to drift at one per node, the arrangement `markGeometry.ts` refused once
  already. Three silent failures: a **mistyped key** compiles, lints and quietly serves the
  category fallback; **scaling a dataset silhouette scales its stroke**, so `specimenShapes` puts
  it back from `GLYPH_STROKE_WIDTH` rather than a transcribed constant, or every dataset tile
  draws faint; and the two renderers can disagree on `strokeWidth` vs `stroke-width`, which is
  visible only by opening both pages. `glyphs.test.ts` pins all three. The category glyphs stay
  as a **fallback**, so adding a node is still free — and `dataset.fib19` is the only entry that
  marks a silhouette (a crop edge), an *addition* to it rather than a replacement, which is what
  keeps "a dataset added tomorrow is never blank" true.
  See [docs/canvas.md](docs/canvas.md).
- **The canvas **+** unfolds rather than opening the browser, and every button in it is derived.**
  `AddMenu` is a rail of seven wordless circles up the corner — the node browser, then the six
  categories — and a **band** of that category's nodes along the bottom, each with its name in
  small muted text. Nothing here is a second table: `nodeDefsByCategory` decides membership and
  order, `glyphs.ts` draws every button (`CATEGORY_GLYPHS` on the rail, one drawing per type in
  the band, the same call `NodeThumbnail` makes), so a node registered next month appears with no
  edit. Five rules. **A wrapping band, not a row out from the button** — Transform holds 25 nodes,
  which is wider than any window, and wrapping degrades by getting taller where a scroll or a cap
  hides nodes. What keeps it attached to the button is the next rule: **the bottom row is aligned
  to that button by measurement**, because where the button sits is the stack's arithmetic and all
  of that lives in `editor.css` — so the button is asked for its rect (in a `useLayoutEffect`,
  before the unmeasured first render can paint), and the few numbers *both* languages need go the
  other way, from `BAND` into custom properties. Two silent costs: a node button's height is fixed,
  since a one- and a two-line label would otherwise sit their discs at different heights above the
  row bottom the alignment measures from; and it carries **no** border, not even a transparent one,
  which inside that height pushes the disc a pixel off. **The fill snakes and a partial row keeps
  its own direction** — bottom row right-to-left from the button, the next left-to-right — which is
  what makes an unfinished top row continue the row below it rather than float; `snakeRows` chunks
  the list *in order*, so the DOM order stays alphabetical whatever the drawing does, and jsdom
  lays nothing out so the rows are pinned as arithmetic rather than through the DOM. **A closed
  surface is unmounted, not hidden**: `visibility: hidden`
  drops a button from the tab order in a browser and from nothing under jsdom, which computes no
  styles, so the test would pass while asserting the opposite of what ships. **The animation is
  `@keyframes`, not a transition**, because a mounting element has no previous computed style to
  animate from and every stagger delay would be spent on nothing. And **`column-reverse` draws the
  first child last** — the **+** is written first and drawn at the bottom; backwards, the whole
  stack hangs off the wrong end of the corner, which is what it did until a browser showed it. Two
  more that only bite from outside: the class prefix is `fab-menu` because `add-menu` is the
  *command palette's*, down to `add-menu__name`; and `data-tour="add"` is on the stack rather than
  the button, since `tour.css` restores pointer events to the spotlit element **and its subtree**,
  so anchoring on the **+** makes the rail it opens inert for the step that asks a reader to open
  it — and the band is a *sibling* of that stack, which is why "Learn to Build" walks the menu in
  **three** steps anchored on three surfaces: a step spotlighting one surface while asking for a
  click on another cannot be completed, which is what the old single "open the node browser" step
  silently became. Its steps drive the menu through `setAddMenu` on the store, `sourcesOpen`'s
  lift exactly — a tour has to be able to put back what it opens. The feedback nudge parks in exactly the gap the rail unfolds into, so it
  **withholds itself** off an `addMenuOpen` store flag, the way it already does for
  `startPageOpen` — where a `:has()` rule in this menu's stylesheet would put one component's
  visibility policy in another component's file, and jsdom computes no styles, so that version
  was the one that could not be tested. See [docs/canvas.md](docs/canvas.md).
- **`defaultSize` sizes React Flow's _wrapper_, and only a viewer's card fills one**
  (`category: 'visualisation'`). Elsewhere it leaves the state bar hanging below the card. A
  node that only wants to be wider sets `NODE_BODIES[type].width`.
- **Two wires between the same pair of nodes are not a cycle.** `topoSort` derives indegree
  from the same index that decrements it, so the two cannot disagree again.
- **Copy is bound to the clipboard *events*, and a paste that is not a graph must fall through.**
  ⌘C/⌘X/⌘V ride `copy`/`cut`/`paste` rather than keydown, because `clipboardData` is readable
  inside the browser's own gesture where `navigator.clipboard.readText` is a permission prompt in
  Chrome and a refusal in Firefox. So `readFragment` runs *before* `preventDefault`: most of what
  is on a clipboard is prose or a column of ids, and swallowing one is invisible from inside the
  app. A fragment **is** a graph file plus a marker — `readFragment` is `deserializeGraph` with a
  `{`-prefix gate before and a "nothing survived" test after, so a `.coda.json` pastes too and no
  second lenient reader can forget a repair. `duplicateSelection` is the same pair (`subgraphOf` +
  `insertFragment`) with the clipboard taken out. Three more: a live
  text selection wins over the canvas selection; a paste is placed at a point the canvas supplies
  (the pointer, or the middle of the pane) because a fragment's absolute positions can be a screen
  away in another graph; and a repeat at that same point **steps**, since ⌘D cascades off its own
  selection and a paste does not. **Copy is live under the lock** where cut and paste are not.
  See [docs/canvas.md](docs/canvas.md).
- **A hint is docked to a card and dismissing it is not an edit**, and both halves are the design.
  `NodeHint` is a field on `GraphNode`, not a document-level list, because a hint belongs to
  exactly one card where a frame spans several — so duplicate, copy/paste, `subgraphOf` and delete
  carry it for free. It draws as a **sibling of `.coda-node`**, which clips with
  `overflow: hidden`, so `bottom: 100%` / `top: 100%` against React Flow's wrapper dock it with no
  measurement and no `ViewportPortal` — a Table card growing to 387px on its first Run takes its
  hint with it, seen in Chrome. Absolutely positioned, so it moves no wire and `placeGuards` never
  sees it; width is the card's, which is what sets the copy at two sentences. **Dismissal is
  `localStorage` and never the document** — a `dismissed` flag would be an undo step, a dirty file,
  and a share link that arrives pre-dismissed for the person being *shown* the workflow — and it is
  keyed on the hint's **text**, so a wizard that mints a fresh graph every time does not re-teach
  the same sentence; the cost is that reworded copy comes back for everybody, and that nothing is
  ever forgotten, which is why **Show Hints** (node menu) and **Show Hints Again** (`?` menu) both
  exist. Outside the card rather than in the issue band, because `nodeIssues` is what the *machine*
  has to say and a reader who cannot tell that from an author's aside acts on neither. The tone is
  a **name** off `HINT_TONES`, `GROUP_COLORS`' reasoning exactly, and the vocabulary is
  `markdown.ts`'s `CalloutTone` — held together by a type-level assertion, since `core` cannot
  import it. Three of the wizard's four Text notes are hints now; the overview stayed a note
  because it is about the *graph* and has no card to point at, and every wizard hint docks
  **bottom** because a top one is drawn into that note. See [docs/canvas.md](docs/canvas.md) and
  [docs/wizard.md](docs/wizard.md).
- **A group frame is not a React Flow node — and a *folded* one is, which is the same argument
  reaching the opposite answer.** Expanded: `ViewportPortal` at `z-index: -1`, `pointer-events:
  stroke` on the rect alone (the interior must stay click-through), `nopan` because panning is
  d3-zoom's *native* listener and `stopPropagation` cannot reach it; membership is a list of node
  ids and the box is derived, since `parentId` would re-base every child's `position`, which five
  subsystems read absolutely. Folded, there are no members on the canvas at all — it is a box
  wires arrive at, which is what a node is, and drawn in the portal instead it would need
  hand-rolled edge geometry, handles and a hit test for both ends of every crossing wire. Still
  not in the document: the pseudo card is minted per render by `layout/collapse.ts` and declares
  its own two **ports**, which is `resolveSize`'s arrangement (*a node carrying its own value beats
  the registry*) and is what keeps `elkGraph.ts` from knowing this feature by name; and
  `draggable`/`selectable`/`deletable` are all false, each closing a path that would reach the
  store with an id naming nothing — **whose price is that React Flow then withholds the pointer**
  (`pointer-events: none` on a wrapper with no flags and no mouse handlers), and both failures read
  as features working: the drag reached the pane and *panned the canvas*, which moves the box on
  screen by the drag delta, and the right-click opened the node palette. `node.style` is spread
  after that line, so `style: { pointerEvents: 'all' }` puts it back — and a browser check of a
  drag has to assert that everything *else* stayed still. **One derivation, two readers** — `collapsedView` answers the
  canvas *and* the ELK pass (`condense` folds each group to one node, `expandPositions` moves the
  members by the delta the box got), because an arrangement made against the members while the
  canvas draws a box moves cards nobody can see. Crossing wires **merge by their two visible
  ends** and are un-interactive: N stacked hit targets under one line each delete a wire into a
  card the reader cannot see, and the key keeps the *port* so two sockets on one card stay two
  wires. **A folded group can carry its members' params** (`GraphGroup.exposed`), which is a
  **reference and never a copy**: the row is the same `ParamField` with an `InferContext` built
  the way the card, the inspector and the styling rail each build one, writing through the same
  `setParam(nodeId, …)` — one value, two editors, and nothing about evaluation or the provenance
  key differs because nothing about the param does. Three ways the reference stops naming
  something, in two places: `validGroups` and the edit refuse a non-member or an undeclared param,
  `pruneGroups`/`createGroup` drop a deleted or regrouped card, `cloneGroups` **remaps** them (or a
  duplicate's controls write to the original's cards), and `visibleIf` is asked in `collapsedView`
  rather than in the file because it answers differently a keystroke later. One call decides the
  rows *and* the box's size, so a row ELK reserved no space for cannot exist. **Looking inside a folded group is a second React Flow in a modal** (`GroupPeek`), holding the
  members' own live cards from `subgraphOf` with `previews: false` and nothing that writes a
  position. Two costs, both silent: the same cards carry the same `data-id`s, so
  `measureCardSizes`, the port measurement and `spliceOn` are scoped to `.canvas-area` — unscoped,
  ELK sized the graph from cards in a dialog and `structureKey` changed when a peek opened; and a
  card that is neither draggable nor selectable gets `pointer-events: none`, so `CARD_POINTERS`
  restores it (the box needs the same) and the panel stops **bare** keys, or a `d` typed at an
  inert field opens the dashboard behind the dialog — the deeper fix, both canvas listeners asking
  `isDialogOpen()`, is written up in the doc and deliberately not taken, because eleven tests
  encode the opposite contract for the thirteen other dialogs. The trap that only a browser shows: React Flow's **multi-selection rectangle** includes
  hidden nodes, so a folded group left an 850×240 draggable box over the canvas its cards had
  vacated — the overlay is stood down (`has-folded-selection`) rather than the `selected` flags
  being falsified, because a hidden card React Flow does not know is selected is one a pane click
  cannot deselect, and the store's selection would then accumulate cards nobody can see for the
  next ⌫ to take. See [docs/canvas.md](docs/canvas.md).
- **`overflow-y: auto` clips the other axis too**, so a `Dropdown` holding a flyout submenu
  must pass `flyouts` to switch the panel's scroll off, or the submenu renders as a horizontal
  scrollbar. And **a shortcut's glyph is stored by meaning, not as text** — `src/ui/shortcuts.ts`
  is the one table, `formatChord` the only place that knows ⌘ from Ctrl, and four surfaces read
  it. `Editor.tsx` still owns the *bindings*. See [docs/ui-shell.md](docs/ui-shell.md).
- **A dialog that opens itself while a tour is running is a dialog nobody can use**, and an
  anchor that can fall back resolves before the thing it names exists. driver.js makes everything
  but the spotlit element `pointer-events: none`, so a modal arriving mid-step can be neither
  typed into nor dismissed — which is what a neuPrint 401 did to "Build a Dashboard", whose third
  step creates a dataset node that peeks on creation. `SourcesPanel` asks `isTourActive()` and
  sends the message to the status bar instead, keeping `reason` so opening it by hand still lands
  on the failing tab; the tour asks for the token in a step of its own first (`when`,
  `interactive`, `advanceWhen`, and an `after` that closes the panel — Next has to be a way out).
  The rule is about self-opening dialogs, not about neuPrint. Second half: that step's anchor must
  be the panel and **nothing that could stand in for it** — `?? byTour('connections')` resolved
  instantly, ending driver's `waitForElement` poll before React had committed, so the spotlight
  and the pointer events went to a 28px icon behind the dialog and the form stayed inert. Both
  halves were A/B'd in a real browser. **`TourStep.when` is asked once, at start**, because `go`
  indexes into the filtered list. See [docs/ui-shell.md](docs/ui-shell.md).
- **The Workflow Wizard replaced the bundled examples, and its option space is gated rather than
  offered.** Four questions — dataset, how to pick neurons, analysis, view — and `buildWorkflow`
  assembles the chain. Every question narrows against what came before: on `capabilityAnywhere`
  (browsing needs `neuronIndex`, 3D needs `skeletons`, a Neuroglancer cell needs `viewerScene`)
  and on what the analysis *produces*, since a heatmap wants a matrix and a table wants a table —
  `VIEWS` is that pairing **and** the node each pair ends on, one table read by both halves, after
  three tables of which two were already wrong. The fourth question takes a **set**: several
  viewers hang off one chain, side by side and stepped by `cardWidth`, because a viewer's height is
  its content (a run Table card is 387px) and stacking them overlapped the moment the graph ran. Four consequences worth knowing. **It asks the ceiling, not the
  floor** — `capabilityAnywhere`, because a wizard answer is a *family* and no dataset id exists
  yet, where `capabilityOf(source, undefined, …)` gives `source.capabilities` and CAVE's
  `skeletons` is a deliberately safe `false` there: that hid Morphology and NBLAST for all three
  CAVE families, each of which has skeletons. The ceiling names **only keys that vary** (`paths`
  stays false at both ends), the node still reads the floor so a real absence lands a message
  rather than a silent un-offer, and the test asserts both directions **per backend** — the
  existing positive check covered one capability on one neuPrint family, so nothing pinned
  `skeletons` on CAVE and an over-refusal shows the reader nothing. **`capabilityOf` answers `true` for a
  source nobody registered**, so anything enumerating combinations at module-init or SSR time
  (`nodeguide/data.ts`, a `describe.each`) must `registerBuiltinSources()` first or it silently
  offers more than the app does. **A generated search is capped** — `SEARCH_LIMIT` on a published
  dataset because auto-run is on by default, and `GEOMETRY_LIMIT` on the *search* of a morphology
  workflow because a skeleton node's `Limit` is a warn-above threshold and not a cap. And the
  examples' fixture standing moved with them: `demoWorkflow()` is what the tour's empty canvas and
  thirty test files load, so the graph the suites exercise is the graph the app ships. And **three
  of its four notes are now hints** docked to the cards they were about — see the hint rule above.
  See [docs/wizard.md](docs/wizard.md).
- **The launch sequence is one boolean and a stage, and the guides dialog is the first stop.** A
  first visit opens on `GuidesDialog` — the three `TOURS`, first one badged — and the start page
  waits behind it. `startPageOpen` means the sequence is showing, `guidesOpen` that it is still at
  its first stop, and `useLaunchStage` is the only place the two are read together: a second
  independent boolean would have meant teaching the toolbar, the share link, `openZoo` and thirty
  tests about a modal they close today for free, and a modal nobody closed is not an assertion
  anybody wrote. Shown **once ever** (`coda.guidesSeen.v1`, written on sight, not on close), which
  is what earns it the front slot. A guide taken from it comes back to it — `beginGuide` leaves
  `guidesOpen` true and `tour.ts`'s `onDestroyed` calls `finishGuide` after `restore` — while one
  from the `?` menu ends on the canvas, the difference being a closure flag rather than anything
  the tour knows. A **checkmark means finished**: only `go` walking off the end of the step list
  sets it, since ×, Escape and every other `destroy` reach the same hook. And the tick is green
  where the word beside it is not — `--status-ok` clears 3:1 for a mark and misses 4.5:1 for 11px
  prose. See [docs/ui-shell.md](docs/ui-shell.md).
- **Small screens get a notice, not a layout, and it stands the guides dialog down.** Coda is a
  canvas of cards, an inspector and a dock; there is no phone-sized form of that, so
  `smallScreen.ts` says so once over an **opaque** backdrop — the one in the app, because every
  other dialog tints the canvas *as context* and this one is about the canvas not fitting. It is a
  media query and not a UA string (a narrowed desktop window is the same problem, a tablet is a
  string away from being called a phone) and it asks **both axes**, since a phone in landscape is
  wide: `(max-width: 720px), (max-height: 560px)`, both sitting in the gap between every phone's
  440 short axis and the iPad mini's 744 — a tidy 768 takes every tablet with it, which is why the
  test pins the numbers against real device viewports through a parser that **throws** on a query
  shape it cannot read. The silent half is `GuidesDialog`: `coda.guidesSeen.v1` is written on
  *sight*, so mounting behind this would spend a first visit's one appearance on a modal nobody
  saw — it returns null instead, because "shown" is the honest key. Invisible to every other `App`
  suite, since jsdom's `matchMedia` answers `false` to everything. The acknowledgement is
  `localStorage` and records **that** the reader answered, never the size: a phone is still a phone
  next week, and a warning that recurs is one you learn to tap through. Growing the viewport
  dismisses it and writes **nothing** — that is somebody fixing the condition, not accepting it.
  See [docs/ui-shell.md](docs/ui-shell.md).
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
- **A second workflow is a second `Scheduler`, and a switch is `loadGraph` keeping the half it used
  to throw away** (*prototype*). The switcher is a canvas panel in the top-left corner; `tabs` is an
  id and a name per row, and the documents live in a `Map` beside the Scheduler on the Scheduler's
  terms. Nothing else changed — 1,204 `useGraphStore` references across 125 files, none of them
  touched, because the document was already a value the store swapped. Four rules. **A Scheduler
  each, not one shared**: `newId` is unique within a *session* and `deserializeGraph` does not
  remap, so two documents opened from one file carry the same node ids *and* the same provenance
  keys — one cache would report the second copy as already run. **Freshness is derived**, so
  `refreshStates` on arrival recovers every badge with no run and no fetch, which is what makes a
  switch free in both directions. **The viewport is captured on `onMove`, not `onMoveEnd`** — a
  gesture-end never fires for a document that was only ever `fitView`ed, i.e. every document nobody
  has panned, and switching to one then leaves the outgoing document's transform on screen. And
  **every open route mints a document** (`openDocument` = `beginDocument` + `loadGraph`), reusing a
  blank *and historyless* canvas so a fresh visit strands no empty tab. That retired the
  replace-confirm outright — `replaceConfirm.ts`, the `confirm-replace` share state and three
  inline prompts are **deleted**, because what the hook was is a guard plus a sentence and the
  guard is what stopped being true; a neutered `ask` would have left four surfaces rendering a
  flow no code path can reach. **`newGraph` stays the in-place reset** it always was — twenty-three
  suites reset with it — and `newWorkflow` is the one that mints a document; overloading the one
  name on hidden state was a silent behaviour change for all of them. Not built:
  closing asks nothing, and `DashboardView` unmounts the canvas and the switcher with it.
  See [docs/ui-shell.md](docs/ui-shell.md).
- **The open set survives a reload in two stores, and the split is about *when* the answer is
  needed rather than about what the data is.** The active document stays in the `localStorage`
  slot, because `loadAutosave` is read synchronously in the store's initialiser and `initialGraph`
  decides the first paint — an IndexedDB read there boots every visitor onto a blank canvas to
  serve the ones with four workflows open. Every *other* open document is `store/session.ts`, in
  IndexedDB, because the ceiling is real at the tail: three documents each carrying a warned
  Explore selection is 2.3 MB of a **5 MiB** quota and `writeLocal` swallows the overflow, so the
  failure is an open set that silently does not persist. Four rules. **`loadActiveDocId` is
  `sessionStorage` and synchronous** — it gives the slot's graph its *identity* in the same tick, so
  the session records restore around an id that already exists; without it a second `createDoc`
  **replaces** the live record rather than adding one, which keeps the row count right and stops
  a rename reaching the switcher, so the test asserts the rename. **The restore is additive and
  never activates**, so a share link followed before it lands is safe. **A document is written at
  the two moments its content can change** — its own autosave debounce, and once as it is switched
  away from, because only the document on screen is on that debounce. And **a duplicated tab takes
  the whole set with it**: `watchTabIdentity`'s reclaim writes every open document under the new
  identity, or the original reloads with one where it had four — the single-slot bug one layer up.
  Fifth, because the two bounds differ: past `MAX_SLOTS` (6) a tab loses its slot and keeps its
  session (12), and `loadAutosave`'s shared-key fallback then hands over another tab's graph — a
  recognisable degradation for one workflow and a *coherent-looking set with one foreign workflow
  in it* for several, so `fromSlot` says which answered and the restore takes its own copy back.
  Only when the slot missed (where it answered it is the fresher copy) and only while the boot
  graph is still on screen. Found at eight open tabs in a browser, not by reading the code.
  The autosave is also the one `serializeGraph` caller that passes **`compact`** (34% of the
  output, measured); byte-identity across paths was never a property, since every call stamps a
  fresh `modifiedAt`. Numbers: `pnpm probe:autosave-budget`.
  See [docs/persistence.md](docs/persistence.md).
- **A pinned viewer is a grid column, and one node is never live in two full-size surfaces.** `⇥`
  docks a viewer down the right of `.app` beside the canvas rather than over it, so `showPreview`
  stands the card down for `pinnedNodeId` exactly as it does for `expandedNodeId` — the same three
  WebGL contexts. The store refuses one id in *both*; two different nodes it allows, so `expandNode`
  releases the pin only for the same node while `pinNode` always closes the overlay. The canvas
  column is **`minmax(0, 1fr)`**, because React Flow's pane reports the whole graph's extent as its
  automatic minimum and a bare `1fr` pushes the dock off screen. The stored width is a **fraction**
  of the window, under a **px** floor — the two clamp different things — and *which* node is pinned
  is deliberately not stored, because a node id means nothing in the next graph.
  See [docs/ui-shell.md](docs/ui-shell.md).
- **A dashboard cell is a reference to a node id, and the grid replaces the canvas rather than
  covering it.** `D` swaps `Editor` for `DashboardView` in the same grid area, so React Flow
  unmounts and every card's preview goes with it — a grid of live viewers *beside* a canvas of live
  previews is two contexts per node, so the swap trades them rather than adding. Hence: **at most one cell per node, and only nodes that can be
  drawn** — both enforced in `addCells` *and* `validDashboard`, because a hand-edited file is the
  other way each arrives, and because written per surface the eligibility half was three spellings
  with two live holes (`canHaveCell` is the one answer, `placeableIds`/`unplacedNodes` what the
  surfaces read); **the dock does not render while the grid is up**, since it is a column that
  survives the swap and is the one surface that could hold a node live beside a cell — dropping the
  pin alone let a later pin put it back; and a cell stands down for the overlay exactly as a card
  does. `ViewerSurface`'s `controls` prop names the property rather than the caller, and **density
  is CSS's** — a frame wears `.viewer-surface` and a class of its own, so it restyles the inside
  without the shared component knowing a caller by name. **Order is position** — no `x`/`y`, flow is not `dense`, so a gap is visible rather
  than CSS reordering the list somebody just dragged. The **layout is in the document**, which
  inverts the dock's rule on purpose: a node id means nothing in the next graph, which is why the
  ids belong to *this* one. So is **which view it was saved from** — `DashboardLayout.open`, so a
  graph saved from the grid opens into the grid; a different promise from the lock's deliberately,
  since a dashboard takes nothing away and `← Canvas` is on screen. Three rules keep that invisible
  to anyone not using it: written **only when true**, a mode toggle **cannot mint a layout**
  (`setViewOpen` answers by identity with no dashboard), and it is **not an undo step**. The layout
  mutators compose `setViewOpen` *around* their change so the first cell and the flag land in one
  commit. And every dashboard action is **live under the lock** — freezing the canvas so it can be
  used as a dashboard is the want this replaces. A cell is **a third, a half, two thirds or the whole** of the visible area
  (`ROW_SPANS` over `ROW_TRACKS = 6`, snapped), and the row height is **measured, not `1fr` and not
  `vh`** — `1fr` shortens every row as one grows, so the resize handle visibly does nothing, while
  `vh` is the window rather than what is left after four bits of chrome, so every dashboard got a
  scrollbar it had not earned with the bottom row's grip behind the status bar. `DashboardView`
  observes the grid's content box and paints `--dash-row` straight onto the element, never into
  state. Note **absence means a different number on each axis** — `w` 1, `h` half — because a row
  track is not a natural unit. See [docs/dashboard.md](docs/dashboard.md).
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
- **A synaptic partner is usually not a neuron, and a node emitting an edge list has to say which
  it meant.** Connectivity matches its far end as a bare node, which is right for a weight total
  and was wrong as the only option: on `male-cns:v1.0`, five LC4 neurons downstream at weight 1
  reach **4,252** distinct partners of which **496** carry `:Neuron` and **492** survive that
  dataset's own `superclass` default — 88% of the result being bodies nothing downstream can look
  up. `Include fragments` is the control, off is the default, and three rules hang off it.
  It is asked as a **`findNeurons` lookup per hop**, not as a clause compiled into five backends,
  so "published" means exactly what `Find Neurons` means on the same card and the `Neuron Set`
  port beside it cannot disagree; **seeds are exempt**, since a body somebody pasted in is not a
  body to filter away; and it bounds the **frontier** as well as the rows, so a hop-2 result is
  not the unrestricted one with rows removed. `absentMeans: 'all'` — a stored graph queried every
  partner and keeps doing so, which is the case `ParamBase.absentMeans` exists for. Both
  exporters already restricted the far end and had **always** silently disagreed with the canvas:
  `fetch_adjacencies` turns a `None` into `NeuronCriteria()` whose label is `Neuron`, and
  neuprintr's `neuprint_connection_table` builds `(a:{node})->(b:{node})` from
  `ifelse(all_segments, "Segment", "Neuron")` — both read off the installed package and the
  published source, and `:Segment` measured as exactly the bare match. So the new default is the
  text they already emitted, and `all` is what needed writing. Last trap, the one a golden file
  cannot see: `Neuron Set` under full meta data is a **left join**, because `findNeurons` answers only
  about published neurons and a lookup keyed by an endpoint list comes back shorter than the list
  — the two ports being the same set is the property the port exists to have.
  See [docs/nodes.md](docs/nodes.md).
- **A synapse point cloud has to say what one row counts, and "min weight" was a confidence
  threshold.** Two bugs that hid each other, both found by pointing Explore Dataset and a Synapses
  node at `male-cns:v1.0` body 10001 and noticing 1,015 pre / 18,582 post against 13,617 points,
  all `post`. First: `synapsesCypher` wrote `s.confidence >= minWeight` against a **0..1** predictor
  score, and the param was an `int` floored at 1 — so the *default* meant "perfectly confident
  only", with no value meaning "everything". It kept 213 rows in a 200,000-row hemibrain sample and
  **no presynaptic site at all** on MANC, optic-lobe or male-CNS, whose pre scores top out at
  0.98–0.99. It is `Min confidence` now, a `number` defaulting to **0**, inspector-only, and with
  **no `max`, because there is no shared scale**: 0..1 on neuPrint, a tracer's 1..5 on CATMAID,
  `cleft_score`'s few hundred on FlyWire. **Renaming the id is what carries stored graphs across** —
  `normalizeParams` reads only declared params, so an old `minWeight: 1` leaves the provenance key
  and absence falls to off; not `absentMeans`' case, since here absence and the default agree.
  A source that cannot honour it **warns** rather than dropping it: every CAVE table but FlyWire's
  declares no score column (Aedes has `size`, a cleft area), and the mock has none — silence was
  defensible only while the default excluded nothing. Second, and hidden by the first: a neuPrint
  neuron holds one `SynapseSet` **per partner**, so the bare walk returns a T-bar once per partner
  it drives — 4,491 rows for 1,015 sites on body 10001, 7.4× on hemibrain — and the surplus rows
  carry *nothing* distinguishing, because `neuprint/schema.ts` drops `partnerId` on purpose. They
  were weighting a multi-partner T-bar 4–8× in syNBLAST and every density measure. `WITH DISTINCT
  n, s` is the fix and neuprint-python's own. It could not simply always run, because **the three
  backends enumerate in different currencies and only one has a choice**: CAVE has no presynaptic
  site identity (`pre_pt_supervoxel_id` is a supervoxel, not a T-bar) and CATMAID already answers
  one row per connector (1,709 rows, 1,709 connectors on FAFB skeleton 16), so neither unit is
  deliverable everywhere. Hence `Rows` is `skeletonParams.ts`' shape — `Automatic` plus the units
  the source declares in `DataSource.synapseUnits` (a **non-empty tuple**, so `[0]` always answers
  and there is no empty state for two readers to disagree about), a pinned unit it lacks an
  **error, never a substitution**, and `resolveSynapseUnit` reading both halves so the
  `Automatic (…)` label cannot name a unit the fetch would not take. **Automatic is `sites` where
  both exist**, which is neuPrint. Three departures from the skeleton control, each because the
  *kind* of question differs. A unit is a property of the **transport** rather than of a bucket, so
  the list is a static property and `validate` complains with no peek. **`SynapseRequest.unit` is
  required and resolved once, at the node** — where `requireSkeletonRoute` earns its per-source home
  from a per-*dataset* half each source must answer anyway, a unit has none, so a copy in each
  `fetchSynapses` was three re-derivations of a static fact that all three *discarded*, plus a
  fourth place for a new backend to forget; required at the request seam, `fetchSynapses` has one
  door and a missing declaration is a compile error. And a **lone unit is not listed** as an option
  (a `sites` entry on CAVE whose only outcome is an error is a control with one working setting) —
  which is the trap in it: a graph pinned to a single-unit source's *own* unit then falls into the
  "chosen but unlisted" branch and gets drawn `links (not available here)` while `validate` says
  nothing is wrong, until that branch looks the unit up in the served list first. The refusal
  sentence is **one function two layers render** (`synapseUnitRefusal`), because written separately
  they immediately said `“sites”` and `“one row per site”` about the same thing — `UNIT_LABELS`'
  own rule broken between its own two readers. There is deliberately **no third reader**: a
  `PointsValue` carries no unit, so nothing says which one answered after a run and syNBLAST cannot
  notice it has been handed one cloud of each — the gap this stopped short of. Both exporters had **always**
  disagreed with the canvas — neither emitted `minWeight` — and they diverge in opposite directions
  now, each saying so: `fetch_synapses` always de-duplicates and takes `confidence=` (emitted only
  when set, since its default is the dataset's own `postHighAccuracyThreshold` and `0` would
  *disable* a floor), while `neuprint_get_synapses` has neither and is therefore the `links` unit.
  See [docs/nodes.md](docs/nodes.md) and [docs/backends.md](docs/backends.md).
- **A normalised weight is meaningless without its denominator, and there are two of them.** The
  Connectivity node's `Normalize` emits `weightTotal` beside `weightNorm` because the same 0.04
  means two things: on male-cns body 10005 the outgoing weights sum to **23,423** over every
  partner and **9,324** over partners neuPrint labels `:Neuron` — only ~40% of a neuron's outputs
  reach a named neuron, against 98% of its inputs, because outputs land on dendrites. Three rules
  fall out. The outgoing denominator is **`downstream`, never `pre`** (2,837 T-bars against 23,423
  synapses — `pre` gives a plausible fraction eight times too large); the totals query matches
  **`:Segment`** on the queried end, so a fragment on the far end of an edge gets a denominator
  rather than silence; and a missing or zero denominator is **null and counted**, never zero,
  because zero divides to an `Infinity` every chart draws off the top of the axis. Region split and
  restriction are one operation with the sum in a different place, so `minWeight` applies to the
  restricted connection **before** the split — turning the split on cannot change which partners
  are found. The primary set tiles male-CNS and MANC exactly and loses under 1% on hemibrain and
  optic-lobe, which is a documented drop rather than a `NotPrimary` bucket. And an attached edge
  set **removes** both capabilities where it *adds* `paths`: a file of `pre, post, weight` has no
  regions, and its weights are not the population the backend's totals count.
  See [docs/nodes.md](docs/nodes.md) and [docs/backends.md](docs/backends.md).
- **A path's denominator belongs to a population, and the floor that uses it has to prune while the
  search is still running.** `Paths` normalises with `Connectivity`'s vocabulary exactly —
  `Normalize by`, `Denominator`, `weightNorm` beside `weightTotal` — but a type-collapsed edge's
  weight is every LC4→PLP1 synapse summed, so its denominator is everything *every* PLP1 neuron
  receives. The frontier carries the type name, so a per-neuron total cannot answer it without
  shipping the whole membership back out; hence `fetchGroupTotals` / `GROUP_TOTALS_SCHEMA`
  (`key, total`, keyed in the traversal's vocabulary where a key is a type name **or** an id as
  text) — a second method rather than a widened `fetchSynapseTotals`, whose key is an id read
  through `idText`, and a second predicate `canTotalGroups`, because the *method* is separately
  optional and a source carrying the flag without it must refuse before the run. Its type arm
  matches **`:Neuron`** where `synapseTotalsCypher` matches `:Segment`: a denominator counts the
  population its numerator came from, and the numerator is `pathStepCypher`'s. Four consequences.
  **Per hop, not once at the end** — that is the whole of what `Min fraction` buys, since a
  denominator arriving after the search can rank what was found and cannot change what was walked;
  the cache is asked per key, because a hub type is reached on most hops and the bidirectional walk
  meets in the middle by construction. **`Rank by` is a control because the two weakest links are
  different steps**: L1→DNp02 in four hops on the mock optic lobe gives eight LPLC2 routes at 375
  synapses against the LC4 route's 352, and 15% of LPLC2's input against 61% of LC4's — the
  ranking inverts, and the bound, the neighbour order and the shortlist therefore read the metric
  through **one** function, since a search bounded by one number and ranked by another prunes away
  its own answer and still returns something plausible. **An unmeasured connection is never
  dropped and never scored** — the floor lets a null fraction through, because a threshold that
  deleted what it could not measure would report an absence as a decision; such a route ranks
  below every scored one, counted and warned about, and `RankedPath.bottleneckNorm` is `null`
  for it exactly as it is for a run that never normalised, since nothing reads those apart and
  *which question was asked* is the caller's own answer. And the Paths table carries `bottleneckNorm` with
  **no denominator column**, inverting `weightTotal`'s rule on purpose: a route's two bottlenecks
  are routinely different steps, so one column could name the denominator of neither — the Network
  output is where each fraction sits beside its own total. Both exporters refuse it, one reason
  past `Connectivity`'s: without a group denominator *and* `Min fraction` they walk a different
  graph, not the same one missing two columns.
  See [docs/nodes.md](docs/nodes.md) and [docs/backends.md](docs/backends.md).
- **A bounded influence score is the published one truncated, not an approximation of it — and the
  gain is the published `lambda_max` exactly.** `r = (I - gW)^-1 s` is the series `s + gWs + g²W²s
  + …`, so walking *H* hops and adding the terms *is* Bates et al.'s score stopped early. Every
  term is non-negative, which makes the answer a strict lower bound and turns all three losses —
  the unwalked tail, the frontier limit, the drive that reached a fragment — into numbers rather
  than caveats. With input-fraction weights W is row-stochastic, measured at `lambda_max(W) =
  1.0000000000` on `InfluenceCalculator`'s own C. elegans matrix, so the package's rescale *is* a
  per-hop factor and `Gain` is the same knob. **Which is why the default is 0.5 and not their
  0.99**: a budget of *H* hops covers `1 - g^(H+1)`, and against the exact solve four hops keeps
  97% of the score and 19 of the top 20 at 0.5 against 6.5% and 6 of 20 at 0.99 — their own
  docstring says 0.99 amplifies the leading eigenmode a hundredfold, and that eigenmode belongs to
  the connectome rather than to anybody's seed. `syn_weight_measure='count'`, their default, is not
  implementable here at all: its scale factor is spectral. Four more rules. **The directions are
  not symmetric and the cheap one is the one people ask for** — `inputs` fetches an input list,
  which is the edges *and* their denominator, and conserves mass exactly, so a discarded fraction
  is a discarded fraction of the answer; `outputs` needs a second `synapseTotals` lookup and has no
  mass bound, and `propagate` throws rather than out-normalising. **It is not a BFS**: `W^k s` needs
  every neuron holding mass at hop *k* to spread it whether or not it spread at *k-1*, which is what
  puts recurrent loops in at all — so a neuron is *fetched* once and propagated from every hop,
  where `traverseConnectivity` skips an expanded node. **`Denominator` gates the modes** rather than
  being swapped per backend (two real Ws under one column name is `Normalize`'s refusal one layer
  up), and defaults to the traversal sum because `synapseTotals` is false on three of five sources.
  **Meeting in the middle buys fetch count, not depth** — unlike `pathOps`, a one-ended run is
  already the whole answer, so the split is for `ball(A)+ball(B) << ball(A+B)`; `combineHalves`
  takes `(channelled, pooled, scored)` because the scored set is presynaptic upstream and
  postsynaptic downstream, and it reports no truncation bound, since each half bounds its own
  series and the combined tail is neither. The Python helper is checked by **running** it — the
  probe execs it out of the golden against a stubbed neuprint and matches the canvas over 277
  neurons to 3.8e-16. See [docs/nodes.md](docs/nodes.md) and `src/help/nodes/neuron.influence.md`.
- **An aggregation's null rule is one decision made in three implementations, and they had
  drifted.** `Group By`'s `mean` divided by `bucket.n` — the *row* count — so a single null pulled
  it towards zero: on `[10, null, 20]` the canvas said 10, the exported notebook 15 and the knitted
  document `NA`, while `pivotTable` in the same file has always kept its own `counts` array and
  said 15. `mean`/`min`/`max` now answer **null** for a group holding no number, where `0` was a
  manufactured measurement among real ones; `sum` still answers 0, which is the identity rather
  than a value. `countDistinct` no longer counts an absence, which is `join`'s rule a few lines
  away and `nunique`'s. The export half is not symmetric: pandas skips nulls by default and base R
  propagates them, so four of the seven need `na.rm = TRUE` in R — and `min`/`max` cannot use it,
  because over an all-absent group it answers **`Inf`** with a warning, a value that survives
  `is.na` and plots off the axis. Those two are generated helpers. The goldens compare emitted
  *text*, so nothing in the suite could see any of this; the fixture now carries a second Group By
  purely so `probe-r-helpers.R` runs one of them. See [docs/nodes.md](docs/nodes.md).
- **`Normalize`'s guards were assumptions, and an empty line is not an unusable one.** `total > 0`
  and a maximum accumulated from `0` are correct for synapse counts and wrong for every signed
  matrix — and NBLAST calls its scores "the value the Heatmap and Normalize already understand",
  while cosine and Pearson similarity are the other route. An all-negative matrix normalised to a
  grid of zeroes. The distinction that fixes it is between a line of *zeroes*, which is measured
  and stays zero, and a line that **holds values** and still totals zero or less, which has no
  fraction and comes out empty with a count said out loud. `max` takes the largest *magnitude*,
  identical wherever nothing is negative. See [docs/nodes.md](docs/nodes.md).
- **A per-seed channel is indexed by position, so the node deduplicates before anything reads it.**
  `propagate` sizes its channel array from `[...new Set(seeds)]` while `Influence` handed
  `influencePairs` and `combineHalves` the raw `idColumn`, so a `Neurons` table with a repeat in it
  — `Stack Tables` over two overlapping searches, or either import node — shifted every channel
  past the first duplicate: one neuron's influencers filed under another's name, the last query
  missing, and the surplus candidates `NaN`. A test has to use an **interleaved** repeat, because a
  set stacked onto itself is already aligned in its first *n* entries and hides it.
  See [docs/nodes.md](docs/nodes.md).
- **The Heatmap's row and column filters are one term each, and a pattern is opted into with `/`.**
  Explore's grammar, narrowed: a plain term is a case-insensitive substring, `/^LC[0-9]+$` (closing
  slash optional) is a regex, `!` or `-` negates. `bareRegex` is **imported** from
  `neuronSearch.ts`, since where a pattern *ends* is the fiddly half. The opt-in is not taste:
  `SMP001(a)` compiled as a pattern matches nothing, which is why both exporters emit
  `regex=False` / `fixed = TRUE` for a literal — checked by running them. One term per axis
  because two substrings ANDed against a short label is almost always empty. **An uncompilable
  pattern leaves that axis whole** (a half-typed `/^LC[` must not empty the picture) where **a
  filter matching nothing is honoured** and the result is empty. Filter runs *before* the sort,
  and both are one mechanism — a list of indices per axis through `takeMatrix`, which is also
  what `orderedMatrix` calls. See [docs/nodes.md](docs/nodes.md).
- **The Heatmap's Order tab is data and its Colour tab is not, and the split is the node.** The
  sort — total, label, one row or column, clustering — reorders the matrix the node *outputs*, so
  a Table beside the heatmap, the CSV and the notebook show what the card shows; the params are
  in the key and the tab says downstream nodes go stale (`paramGroups` with `affectsData`).
  Palette and scale are presentational and never re-fold four million cells. Four rules. **The
  other axis follows by label, never by index** — an Adjacency is square and not symmetric, and
  "the same order" means the same neuron in row 3 and column 3. **The clustering is seaborn's
  clustermap, not Linkage's**: rows as vectors, distances between vectors, `coda_cluster_order` in
  `linkage.py` (numpy, not scipy — checked against `pdist` by `pnpm probe:heatmap-order`); Linkage
  reads the matrix *as* the distances, and each is wrong for the other's input. It is a
  Pyodide call inside a **`cheap`** node, on purpose. And a constant vector goes to **distance 1**,
  where scipy's NaN would refuse the whole matrix — both exporters write it that way too. The
  palettes beside Coda's own are matplotlib's, **sampled by a script at 64 stops** (measured:
  within two channel values of the 256-entry table; 32 bands on cividis) and **not flipped with
  the theme**, so `cmap='viridis'` in the notebook is the picture on the card. `total` is the
  plain sum: the output cannot read a presentational param. See [docs/nodes.md](docs/nodes.md).
- **The heatmap's colour ends are manual-or-automatic and its log is on the colour alone.** One
  `colorDomain` decides a value's ramp position, so `normalize`, the per-cell `bucketScale`, the
  hit test and the SVG export cannot disagree. A limit is a **`string` param** because a `number`
  has no unset state (`NumberField` coerces back to the default) and `0` is an ordinary limit;
  an inverted or unreadable pair is **dropped whole**, since honouring half of it clamps every
  cell to one end. Out-of-range clamps and the caption admits it. **Diverging offers one end**,
  the magnitude of both arms, or the middle stops meaning zero. The log is
  `log1p(v − lo) / log1p(span)` — labels, tooltip and bar ends stay the values, the shift by `lo`
  is what makes it total on negative data, and it equals the exporters' `log10(1 + v)` because a
  ratio of logs is base-independent. It stays **monotonic**, so the fold's strongest-cell rule
  needed no case. seaborn's **`annot` takes a frame of its own** and ggplot gets a `fill_` column
  beside the untouched `value`: that is how the numbers stay raw under a transformed fill, and
  both were run. See [docs/viewers.md](docs/viewers.md).
- **The heatmap's zoom is a window in matrix units, and the window is what gets folded.** Not a
  scaled canvas: scaling keeps the fitted fold's blocks and enlarges them, and scales the labels,
  which is the one thing they must not do. `HeatmapWindow` goes into `buildHeatmapSpec`, so
  zooming in folds *fewer* cells and past 1:1 real cells appear with their own labels, re-thinned
  for the pitch the zoom gives them. Per-axis `AxisMap`s carry a grid origin that sits *before* the
  plot's edge, so both renderers clip to three zones (`TextMark.zone`). The colour domain is
  memoised apart from the window — a pan must not rescan, and a zoom must not recolour — and
  matrix units are why a resize keeps the zoom. Gestures only off the canvas (`compact` false).
  Two findings from the browser that jsdom cannot make: **the canvas raster is not in any
  `performance.measure`** — 160,000 batched rectangles recorded in 8 ms and cost the frame 250 ms,
  so the cells are now an `ImageData` blitted with smoothing off, and the paths are the SVG
  export's alone; and **an interior line's visible extent equals its pitch only up to rounding**,
  so the sliver test carries a tolerance or a third of the labels vanish at random.
  See [docs/viewers.md](docs/viewers.md).
- **The dendrogram's zoom is a window along the *leaf* axis only, and that asymmetry is the
  finding.** The gestures are `HeatmapViewer`'s exactly — wheel about the pointer, drag to pan,
  double-click or ⤢ to fit, `×N` in the caption, off the canvas only — and like the heatmap's it
  is an **input to the drawing rather than a transform over it**, for a sharper reason: a scaled
  bracket takes its labels with it, and 10px leaf names blown up to 40px is the one thing a zoom
  must not do. So `visibleLeaves` re-thins names for the pitch the zoom gives them and
  `visibleLinks` drops what the window cannot reach (397 brackets/67 names fitted → 51/46 at ×8.7
  on a real 398-leaf tree, measured in Chrome), returning `shape.links` **by identity** at the fit
  so an unzoomed card pays nothing and the memo still bites. **Two axes was built first and is
  wrong in a way only a browser shows**: a heatmap's axes are both matrix lines, where a
  dendrogram's leaf axis is a list and its distance axis is the *measurement* — zooming about a
  pointer part way up it moves the window off the leaves, and ×8.7 drew a column of readable names
  beside two brackets and an acre of empty card, the merges joining what you are reading being
  exactly what you zoomed in to see. Holding the distance axis whole also makes two zoom states
  comparable and keeps the root's crossbar on screen; the case the other version served — a
  single-linkage tree crushed near zero — wants a log scale, not a zoom. Its price is that **a
  drag along the distance axis does nothing**, by construction. Three rules exist only because
  this viewer's purpose is *clicking* branches, which the heatmap has no equivalent of: **pan runs
  only while zoomed** (fitted, the pointer belongs to the brackets); **`draggedRef` is a ref, not
  state**, or `pick`'s identity changes and every bracket re-reconciles on each pointer move —
  a click fires after `pointerup`, so it describes the finished gesture, and it is also why the
  pan state carries no `moved` flag saying the same thing one render later; and **pointer capture
  is taken at the slop, not at the press**, because capturing from `pointerdown` sends the `click`
  to the capturing element rather than the bracket and selection silently stops working the moment
  anybody zooms in. The wheel is **`useWheelZoom`**, shared with the heatmap — the non-passive
  listener, the per-frame coalescing and the one sensitivity constant were written out three
  times, and the third copy had already drifted into re-attaching per render. Everything the
  window feeds is **memoised**, which is not a micro-optimisation: `clampWindow` mints a fresh
  object and the window is a prop of the memoised `DendrogramLinks`, so an unmemoised one fails
  the shallow compare on every `setHover` — 12,000 elements reconciled per pointer move on a
  fitted tree, and it voids `visibleLinks`' by-identity return at the fit. Two more from the browser: a pan drags across leaf labels and **selects** them
  (`user-select: none` while panning only — `preventDefault` on the `pointerdown` suppresses the
  compatibility mouse events and takes the selecting click with them), and the two clip zones are
  the plot and the gutter, the gutter clipped **along the leaf axis only** or every label is
  erased. See [docs/viewers.md](docs/viewers.md).
- **A dendrogram leaf's *name* is a drawing and its *label* is the identity, and the Annotations
  port only ever touches the first.** A `LinkageValue` knows its leaves by one `string[]` taken
  off the matrix's row labels, and a `MatrixValue` axis is also just `string[]` — so on every
  route into Linkage but NBLAST's (which has `Label by`) a leaf is a bare root id, because
  `core.similarity`, `neuron.adjacency` and `core.pivot` all label their axes with the id column
  they were handed. `out.dendrogram`'s `Annotations` port takes an ordinary table and
  `Match on`/`Label by` join it onto the leaf's own label — `displayLabels`, headless in
  `nodes/lib` so an exporter reads the same rule the viewer does. **`evaluate` never reads it**
  and both pickers are `presentational`, which is the whole design rather than an optimisation:
  `Selected.label` is what `cluster.selectedToNeurons` matches against a neuron table, so a tree
  renamed by cell type turns one clade of fourteen neurons into every neuron of those five types
  in the connectome — plausible, wrong, and nothing raises it. Nothing is lost, since
  `Selected to Neurons` already carries the neuron table's own columns across; what is bought is
  that trying `type`, then `instance`, then `hemilineage` changes no provenance key and re-runs
  no `expensive` Linkage. Both pickers are **`optional`** for a sharper reason than taste:
  `resolveColumn`'s rule 3 substitutes the *first compatible column* for a required picker whose
  default the schema lacks, which here would name every leaf after whatever column comes first in
  somebody's table. **The join is `labelsByNeuron`**, the same operation with three callers
  already, so its rules come with it rather than being restated: a blank is no label, the first
  non-blank row wins a repeated id, and ids go through `idText` — which drops an already-rounded
  wide id (invariant 8) instead of naming whichever neuron owns the rounded value, a case that
  presents *identically to an unwired port* and is therefore what the `validate` line exists for.
  `displayLabels` adds only the guard `labelsByNeuron` cannot: four ways of having nothing to
  look anything up in, which it answers by throwing and a viewer must answer with a picture. An **unnamed leaf
  keeps its own label**, inverting `core.relabel`'s `Unmatched` default because a blank leaf is
  worse than the id it replaced; the caption counts them. The identity moves to an SVG `<title>`
  in a `<g>` **beside** the `<text>`, not inside it — both are spec'd the same, but only one
  needs that to hold in every renderer an exported SVG lands in, and jsdom concatenates
  descendant text so a test reads `aLC4` either way. **The Heatmap deliberately gets no such
  port**, though the wizard pairs the two: its row labels are *data*, matched by the Filter tab
  and sorted by the Order tab, both `affectsData` and both in `evaluate` — so a presentational
  rename there shows `LC4` while a filter typed `LC4` matches nothing. That one wants a
  matrix-level relabel, which spends the identity this port exists to keep, and both at once
  would be two answers to one question. Last trap, found by **running** the emitted cell rather
  than reading it: pandas' `dropna` keeps the empty string, so a neuron whose `type` is `''` —
  neuPrint's answer for an untyped body — drew a blank leaf in the notebook where the canvas drew
  its id. **The join the emitters do is `coda_relabel`**, the helper `core.relabel` already emits;
  hand-rolling it keyed on `.astype(str)`, and an `i64` column with one null is `float64` in
  pandas and prints `'101.0'` against a leaf label of `'101'` — the notebook matching *nothing*
  while the canvas matched everything, on exactly the dtype the `validate` warns about.
  See [docs/viewers.md](docs/viewers.md).
- **The graph metrics are two nodes because `cost` is a property of a node type.** `net.metrics`
  is `cheap` and every measure on it is O(V + E); `net.centrality` is `expensive` and runs only on
  Run. One node holding both would have to be `expensive`, and then reading a graph's node count
  and density would need a Run — the one thing about this pair that has to be instant. They
  compose: Centrality writes its columns onto the network, so a Metrics card downstream plots
  betweenness beside degree. Four rules, each of which the obvious version gets wrong.
  **A self-loop counts towards degree and towards nothing else** — it cannot close a triangle,
  cannot join two components, and in density would let a graph exceed 1 — so every structural
  measure runs on the undirected simple projection; that is also where Coda and networkx part
  company, and *both* places it bites were found by running the emitted helpers rather than
  reading them (`overall_reciprocity` divides by every edge, `eigenvector_centrality` keeps loops,
  so one heavy autapse scores 1.0 while every real hub rounds to zero). The metric columns are
  written **over** the ones a network already had, never beside, because `degreeIn_1` next to
  `degreeIn` gives a picker two answers and the second is the stale one. **Sampling estimates a
  mean and refuses to estimate a maximum**: `meanPathLength` is scaled by `n/k`, `diameter` is
  null, because a sampled maximum is a lower bound with no error bar. And **parallel links are
  merged, summing weights, before any path is counted** — Brandes adds `sigma` once per copy, so
  four rows for one pair inflate every betweenness downstream with nothing looking unusual. The
  numbers are pinned against networkx by a checked-in fixture and the exporters by
  `pnpm probe:netexport`, which runs Coda and both generated helpers over one graph. One trap in
  the wiring, because it cost nothing to write and would have shipped silent: **`networkMetrics`
  is memoised and the card calls it too**, from the node's input — so a warning raised *inside*
  it goes to whichever caller arrived first, which on the ordinary chain is the card, with no
  warner. The cost and the drop count ride on the result and `evaluate` warns from them, which is
  `out.describe`'s arrangement.
  See [docs/nodes.md](docs/nodes.md), [docs/viewers.md](docs/viewers.md) and
  [docs/export.md](docs/export.md).
- **A dataset-level filter is not a filter row, the row wins, and the filters OR.** The
  population checkboxes on a neuPrint dataset node are **OR-ed** — a second ticked box lets
  *more* rows through. `typed` matches column names **ending** in `type`. `findNeuronsCypher`
  drops the `traced` disjunct when a filter row names `status`, and all four emitter spellings
  repeat that. Defaults are per **family**. Which queries they reach is `neuronSetRequest`, kept
  separate from `datasetRequest`: never a lookup by id, and never the far end of a `ConnectsTo`
  **except** through Connectivity's `Include fragments` control, which asks it as a separate `findNeurons`
  lookup rather than as a clause in five backends' connectivity queries. The
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
- **A CAVE sign-in is a popup and a `postMessage`, and every hard part is a silent ending.**
  `middle_auth` is itself the OAuth client — it holds Google's secret and owns the redirect URI —
  so its callback page posts `{token, app_urls}` to `window.opener` with target origin `"*"`:
  nothing to register, no secret to ship, and a static deploy can therefore sign somebody in.
  Neuroglancer does the same. Four consequences. The login prefix is **read from `/auth_info`**
  and never assumed — `global.daf-apis.com` serves middle_auth under `/sticky_auth`, where
  `/auth/api/v1/authorize` is a 404. The window is opened **blank, before** the lookup that points
  it, because one opened after an `await` is outside the click and gets blocked. A message is a
  token only when `source` is the window we opened **and** `origin` is the service discovered
  before opening it — the terms-of-service arm posts the bare string `"success"`, and `"*"` cuts
  both ways. And **the paste field stays**, for the exits that hand nothing back — a blocked
  pop-up, and middle_auth's own error pages (no session cookie, expired state, OAuth error). A
  **first login is not one of them**: it is diverted to a "choose a username" form that *does*
  deliver, and it creates the account as it goes, so the first-run failure to expect is a 403 on
  a datastack after a sign-in that worked. That pair was documented backwards once, in the copy a
  user reads. What is stored is the seven-day login token plus a **label, not an expiry** — the 401 is the only thing
  that knows, and `create_token` would instead put a permanent credential in `localStorage` and a
  row on the user's CAVE account. **neuPrint cannot do any of this**, which is a fact about
  DatasetGateway rather than a gap to work around: `REDIRECT_ALLOWED_DOMAIN` is `janelia.org` and
  the token is delivered as an `HttpOnly` cookie. See [docs/backends.md](docs/backends.md).
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
- **Restoring `layers` in the embedded neuroglancer is not safe under the pointer, and one bad id
  is not one bad id.** A layer is constructed — subscribing to the hover machinery — a whole loop
  before it is initialised, which is where `selectionState` is assigned, and neuroglancer never
  disposes that subscription. So any layer that dies in between answers `undefined.generation` on
  every mouse movement for the life of the document, which is the reported crash and why it
  surfaces on `mouseout` rather than on the edit. Two ways in, both closed here: an update is
  **held until `mouseleave`** on `.ng-frame` (replacements too, but never the opening navigation),
  and every segment id goes through **`isSegmentId`** — `parseUint64`'s own
  `^(?:0|[1-9][0-9]*)$`, narrower than `core/ids.ts`, since a miss deletes the layer rather than
  the id. That filter is in **`buildScene`**, not in the node: `NeuroglancerProfileFrame` is the
  other caller and passes whatever `idText` read off a profile row, which by design applies no
  grammar. The node filters *again* only so it can count and `ctx.warn`. Third rule, and it is why none of this reproduces in production: **`proxiedViewer` says
  a prefix is declared, not that anything serves it.** `/ng` is a path on *this* origin, so a
  static deploy 404s instead of degrading — `sameOriginViewer` gates it on `import.meta.env.DEV`,
  which makes the splice and `sceneMemo` dev-only. See [docs/viewers.md](docs/viewers.md).

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

**Five categorical palettes, and only `coda` is validated here.** The other four are published sets
transcribed whole — Okabe–Ito (in R's eight-colour spelling, grey for the unusable black),
matplotlib's `tab10` and `tab20`, ColorBrewer's `Paired`. **The order is ours and only the
order:** `resolveColor` hands the leading slots to the commonest values, so `tab20` and `Paired`
are rotated to put their saturated halves first rather than the published dark/light
interleaving, which would spend the two most important slots on two shades of one hue. A
consequence worth knowing: `tab20`'s saturated half *is* `tab10`. The imported four are one set
for both themes, so the pale members are weak on the light surface — that is the price of the
capacity, and the param's help says so. Adding a sixth palette means transcribing a published
one, not mixing hues.
The heatmap's sequential and diverging ramps follow the same rule: `HEATMAP_SEQUENTIAL` and
`HEATMAP_DIVERGING` in `colors.ts` are matplotlib's, generated by a script, and the stop count was
measured rather than chosen (see [docs/viewers.md](docs/viewers.md)).

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
