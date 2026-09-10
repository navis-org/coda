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

8. **A neuron id is text everywhere — across the `DataSource` seam and in the column a source
   publishes.** `CellValue` is a float64, so an 18-digit CAVE root id parses to a *different
   neuron* with nothing to say so. The rules are one definition each in `src/core/ids.ts` —
   `NeuronId`, `isNeuronId`, `idText` (cell → id), `compareIds` (length-then-lexicographic),
   `numericId`, `ID_COLUMN_NAME`, `isIdentifierColumn` (the name rule, which `src/data` needs
   and so cannot live in `ui/format.ts`) — and there is deliberately **no re-export**, because a
   shim is how a symbol acquires a second spelling. Each source converts at its own edge;
   each backend maps its own id column onto `neuronId` at its own seam. Geometry carries
   the id as plain `id`, as a draw/export key rather than the identity. The UI is where
   this keeps being re-broken: never `Number(...)` an id. And the transport grammar is not the
   only one: neuroglancer's `parseUint64` refuses a sign and a leading zero, which `isNeuronId`
   allows, so a scene goes through `isSegmentId` (`data/neuroglancer/scene.ts`) instead — a
   second predicate rather than a second spelling, because the two really do differ.
   **The dtype clause replaced its own opposite**, and that is the half to read before
   relaxing it: each source used to publish the dtype its *own* ids fit — `i64` on neuPrint,
   whose ids are 9–11 digits and exact as doubles, `str` on CAVE — every one locally right and
   the set wrong, because `mergedDType` refuses `i64` against `str` and so no neuPrint + CAVE
   pair could be stacked. `Join` had been widening that same pair to text all along. One dtype
   now, so `pathStepSchema`/`synapseTotalsSchema` are constants rather than builders taking one.
   Three traps it left: a `dtypes: ['str']` picker was getting an id filter *for free* and needs
   `ColumnParam.excludeIds` to keep it; a cache fingerprint of column **names** is a hit across
   this change and hands back numbers under a text schema (`schemaFingerprint`); and
   `tableFromRows`/`makeTable` validate nothing, so `data/idDtype.test.ts` walks a real source's
   values. The two seams that *sniff* a dtype are forced as well — Upload Table's id column and
   Raw Cypher's `*Id` columns — or the same file from two connectomes still arrives two ways.

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
- **An id has a history, and both halves of a node's saved state need to say so the same way.**
  `Stack Tables` and `Stack Neurons` went from `top`/`bottom` to `in1 … inN` on an `Inputs`
  spinner, and from `topLabel`/`bottomLabel` to `label{n}`. Both renames lose stored state in
  silence: an edge naming a port the node no longer has is dropped with a warning
  (`deserializeGraph`), and a param the definition no longer declares is *ignored* by
  `normalizeParams` — so a label somebody typed reverts to a default with nothing said at all.
  Hence **two declarations, one shape**: `PortGroupDef.formerIds` (positional, since a group mints
  its ids) and `ParamBase.formerId` (singular, since a param declares its own), both read at load
  and both **only after the live id has missed**, so a former id cannot shadow one that is live
  today. The param half also carries `absentMeans`, absence and the new default being different
  answers about a column of *data*. `registerNode` refuses `formerIds` on a group repeating a
  *tuple* (a position names two ports there, so the migration would silently cover half the pair)
  and refuses a `formerId` that collides with a live param or is claimed twice — both would move a
  value with the winner picked by declaration order. Deliberately **not** a per-type migration
  table in the loader: `storedParams` records why that is the wrong tool, and it would put node
  facts in `deserializeGraph` where the registry holds every other one. The first shape here kept
  the historical param ids by hand instead, and it cost an exported id scheme that both node
  files, both emitters and the wizard had to import — a hole in `repeatParams`' scheme that no
  second rename could have reused. See [docs/nodes.md](docs/nodes.md).
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

- **A node's "See also" is a table, because the cross-references it looks derivable from are
  one-way.** Measured across the 64 help documents: 105 prose links, 74 distinct pairs, **12 mutual
  and 62 one-way**, 13 documents in no pair at all — a document explains its own node, so the hub
  nodes everything links *to* were exactly the ones with no way onward, and no document mentions
  its own sibling (Mirror and Transform, the two CATMAID datasets, the three ways to choose
  neurons). `src/help/seeAlso.ts` states it once as **groups**, every member related to every
  other, so a set of four is one line rather than six pairs of which five get forgotten — which is
  how a relation becomes asymmetric. Editorial on the line `guide` and `coda-params` draw: a
  relation derived from a shared category or socket type relates every viewer to every other.
  `seeAlso.test.ts` pins symmetry, that every entry has a document to open, and that **no
  documented node is a dead end**. See [docs/help.md](docs/help.md).
- **A node's glyph is one drawing per type, and the table is data because a third surface has no
  React.** `ui/glyphs.ts`: 103 drawings on eleven base shapes — the base shape names the material,
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
- **A card the layout must not place is condensed, never constrained — and the two cases are a
  companion and a reference.** ELK has no "directly below" constraint and no notion of an edge that
  is not a dependency, so both were being answered by accident. A **Description** card is a credit
  with no outputs, and as an ordinary node layered puts it in the layer *after* its dataset,
  competing with the real next step: measured in a browser at x = −540 beside `find` while its
  dataset sat at −884, and once as the topmost card on a canvas whose dataset was a column back.
  `layout/companions.ts` gives it `collapse.ts`' treatment one level down — the companion leaves the
  graph, **the host's box grows to cover where it will sit**, and it is snapped back to
  `CompanionSpec.offset` afterwards; the growth is the silent half, since withholding and replacing
  looks plausible either way and the only symptom is a card over whatever filled the gap (1 collision
  with it removed). Grown as an **overlay** on the measurement map, never a `size` on the node
  (`resolveSize` reads `measured` first) and never in place (that map is `structureKey`'s). Three
  refusals: a companion carrying **any other wire** stays put, which is also what pins a card fed by
  two datasets under *neither* rather than under the first; a second companion on one host stays an
  ordinary node; and a **negative offset declines**, the box's top-left being the host's, which is
  what keeps a `FIXED_POS` socket offset describing the host. Expansion **snaps**, inverting
  `expandPositions` on purpose: a folded group keeps its author's arrangement, a companion is placed
  by its definition. Separately, **`arrangeScope` withholds every reference edge**
  (`referenceEdgeIds`) — a reference names a node rather than consuming it, which is why `topoSort`
  already excludes it, and an annotation chain reading its datastack out of the dataset it feeds is
  a two-edge loop ELK must break at one end or the other. It picked the annotations edge, drawing the
  chain *after* its dataset. Excluded rather than reversed: reversing asserts a direction ELK then
  reserves a channel for. **Filtering at the scope is not enough, and that half shipped broken**:
  `collapsedView` merges stand-ins from `graph.edges` rather than from the list handed to
  `condense`, so a withheld wire returns as `ds → box` the moment an end is folded — which
  `foldChain` does to FlyWire's chain by default, i.e. the exact graph the rule was for, and the
  arrangement still looked fine (the browser check passed by luck). So `arrangeScope` **returns**
  its `omit` set, `condense` takes it, and `CollapsedEdge.merged` names the wires behind a stand-in
  so one is dropped only when **every** wire behind it was omitted. **One arm cannot show it** — swept with references in, the flip starts at
  two datasets, which is why the fixture has two and why both tests were checked by mutation. Both
  rules together, in a browser at a 1.90 pane: 1.43 → **1.88**, 1.45 → **1.79**, 1.62 → **1.90**.
  Width never moves, so it is all height. The four-dataset figure is the tell: 1.66 with the
  reference rule at the scope alone, 1.90 once `condense` stopped undoing it — the graph with the
  most folded chains had the most to gain, and the broken version looked right in a browser.
  See [docs/canvas.md](docs/canvas.md).
- **A layer is a column, and the tightest layouts break that rule — so packing is a post-pass, not a
  fifth algorithm.** ELK layered spends a whole column on a card that is only ever a leaf and makes
  a graph as tall as its tallest column, which is why a hand-tidied FlyWire workflow measured
  **1939 × 1259 against 1743 × 857** — 63% more area for six cards, most of it a void beside a tall
  Neuroglancer. The move a person makes is to put a card in its *predecessor's* column drawn below
  it (`Explore ▸ Table` as one column), which is a layer violation **no ELK configuration
  produces** — swept, not assumed: all four `nodePlacement` strategies are byte-identical, all five
  `postCompaction` strategies reach +48%, `rectpacking` reaches +8% only by ignoring every edge, and
  `elk.partitioning` *ignored* a column assignment handed back to it and spread the graph wider than
  not asking. `layout/pack.ts` runs **after** ELK — standalone it gives the same answer, so
  replacing layered would only lose crossing minimisation, within-layer order and port order — and
  takes 1939 × 1259 to **1941 × 851**, all of it height. **The objective is one-sided**: it scores
  only how much *taller* than the pane the box is, so a graph already wide enough scores zero and
  comes back untouched — a two-sided score folded a perfectly good four-card chain into one vertical
  column to "reach" 1.6. Two rules keep it readable: a card joins a column at its **bottom**, so it
  may share one with a predecessor and never with a successor (that rule missing put an annotation
  chain *below* the dataset it feeds), and the within-column order is **ELK's**, never recomputed.
  Columns are read off `x` with a **tolerance** of half the layer gap, since layered nudges a node
  whose predecessors are short. Gated by `packApplies` — homed in `options.ts` beside
  `aspectRatioApplies`, one predicate for the checkbox and the pass — which asks for `layered`
  **and `RIGHT`**, a column being a layer only left-to-right (`DOWN`/`UP` make layers *rows*;
  `LEFT` inverts the pred/succ asymmetry). Two further gates stand it down as **correctness**:
  more than one component *while `packComponents` is on* (ELK packs those in two dimensions, so "a
  row of columns" does not describe the answer, and merging across them dismantles that option —
  conditional on it, since with it off ELK gives one shared layering and the model holds), and
  `PACK_MAX_NODES` = 80 — re-measured on the worst legal shape at 33 ms at 80 and **200 ms at
  120**, synchronous inside a promise continuation. The first gate is **not rare**: an unwired card
  is a second component, so packing stands down mid-build; that is a missed improvement, not a
  worse arrangement. `docs/limits.md` carries the row, and the silence is argued there — there is
  no `EvalContext` on a canvas gesture and `setNotice` would re-nag per wire under auto-layout. **The target is the pane**, clamped, and gating it on
  `useScreenAspect` was built and *measured against*: 851 aiming at the pane against 1156 aiming at
  a fixed 1.6, on the graph the feature exists for, answering a complaint that is specifically about
  the screen — a packer aiming at a constant is the wrong answer to it, and one needing a second
  checkbox labelled for something else first is a control shape already deleted here. So
  `useScreenAspect`'s note was **narrowed** to say it governs `elk.aspectRatio` alone; silently
  outgrowing it was the unacceptable part, not the window-dependence. **What it costs is ELK's edge
  routes**, which describe gaps at the positions ELK chose. That signal **shipped broken for one
  round, and is the part worth keeping**: it rode on map identity (`raw !== laid`) while every
  do-nothing exit built a fresh `Map`, so routes were discarded on every arrange including the
  graphs the pass declined — three doc comments described the contract, nothing enforced it, and
  the test meant to pin it asserted *zero* routes after a pack, passing for exactly the wrong
  reason. `moved` is a returned field now, and the test asserts the case jsdom can show: a decline
  keeps the routes.
  See [docs/canvas.md](docs/canvas.md).
- **`defaultSize` sizes React Flow's _wrapper_, and only a viewer's card fills one**
  (`category: 'visualisation'`). Elsewhere it leaves the state bar hanging below the card. A
  node that only wants to be wider sets `NODE_BODIES[type].width`.
- **Two wires between the same pair of nodes are not a cycle.** `topoSort` derives indegree
  from the same index that decrements it, so the two cannot disagree again.
- **A `reference` port that resolved to nothing is refused by the scheduler, and the two states it
  tells apart are invisible to the node.** `datasetIdentity` hands `evaluate` the same `undefined`
  for "nothing wired" and "a wire whose dataset node cannot yet say which dataset it is", so both
  CAVE readers on the FlyWire chain refused in the only words they have — `Wire a CAVE Dataset` on a
  card with a Dataset wired to it. **The ordering references exist for is what made it
  undiagnosable**: those nodes run *upstream* of the dataset node, so the run stopped there and the
  dataset node's own accurate sentence (`whyDatasetMissing`: FlyWire's materialize service was
  answering 503 for every datastack) was never reached, with everything below `blocked`. So
  `gatherInputs` composes `GatheredInputs.refusal` from the **referenced node's** inference issues
  (skipping `aboutColumns`), checked after `blocked`, **after the auto-pass deferral** (it replaces a
  throw from `evaluate`, and both readers are `expensive` — ahead of it, a cold session reddens two
  cards per keystroke) and before `evaluate`; no reason at all means a cold listing, which is not an
  error, so that sentence says *Run again*. Downstream of it,
  CAVE's `explain` reads an HTML body's `<title>` and nothing else — a 300-character slice of an
  nginx page reads as Coda being broken, and a general tag stripper would draw a stylesheet.
  See [docs/core.md](docs/core.md).
- **Copy is bound to the clipboard *events*, and a paste that is not a graph must fall through.**
  ⌘C/⌘X/⌘V ride `copy`/`cut`/`paste`, not keydown, because `clipboardData` is readable inside the
  browser's own gesture where `navigator.clipboard.readText` is a prompt in Chrome and a refusal in
  Firefox. `readFragment` therefore runs *before* `preventDefault` — most of what is on a clipboard
  is prose, and swallowing it is invisible from inside the app. A fragment is a graph file plus a
  marker, so a `.coda.json` pastes too; `duplicateSelection` is the same pair (`subgraphOf` +
  `insertFragment`) without the clipboard. A live text selection wins; a paste lands at a point the
  canvas supplies and **steps** on repeat. **Copy is live under the lock**; cut and paste are not.
  See [docs/canvas.md](docs/canvas.md).
- **A link in a static page names a thing; it never carries one — and the search that resolves the
  name runs at build time.** Every node guide entry opens a real workflow through
  `#!demo://<type>/<dataset>/<analysis>/<view>/<rank>`, and `src/wizard/demo.ts` builds it on
  arrival from the wizard's own graphs: 37 of 102 types are found *inside* a wizard workflow (asked
  across every family, or `out.neuroglancer` demos its own refusal), the rest are appended to a port
  already carrying a compatible value and given a viewer. Three findings. **Packing the graphs was
  measured and rejected** — 27.7 kB gzipped at 37 nodes, ~75 kB at 102, nearly all of it landing as
  base64 between the paragraphs of the appendix, which is the half a crawler and a language model
  read; the name costs **2.7 kB gzipped** for all 102. **The plan is in the link because scoring
  peeks**: candidates are ranked by `inferGraph`, and `inferOutputs` on a dataset node starts the
  listing it cannot answer — so searching on the click fired requests at two CATMAID servers and
  CAVE and put a "No CAVE token" dialog over a workflow about filtering a table. Seen in a browser;
  jsdom reaches none of it and a Node probe counting inference issues sees nothing wrong. And
  **wiring is scored, not reasoned about** — half these ports are `any`, which says nothing about
  what the node wants, so a first-compatible rule wired Mirror to a neuron table and Download to a
  Dataset; the viewer must be chosen from the node's *inferred* output, since every passthrough
  declares `any`. **The in-app `?` overlay carries the same button**, building through `openDocument` rather than a
  link and taking the *trail's* tail so a cross-reference moves it with the reader — and it searches
  with **every dataset buildable, only the synthetic one scorable**, since `buildWorkflow` asks
  nothing of a server and `inferGraph` peeks. Warnings are a ceiling in `demo.test.ts`, errors are
  zero. A demo also starts
  with a **structured search** rather than the wizard's first answer, which is an Explore card
  opening with nothing ticked — auto-run then painted a red "No neuronIds" card as the first thing
  on screen — and the synthetic dataset carries a dismissable **hint** saying the card is
  replaceable, which the wizard's own Demo Data workflows do not, that dataset having been asked
  for. See [docs/pages.md](docs/pages.md) and [docs/persistence.md](docs/persistence.md).
- **A figure that explains a card is a copy of that card, and a copy goes stale silently.** The node
  guide opens on two wired cards with eighteen parts boxed and a note on each (`nodeguide/anatomy.ts`),
  and **two** because the chrome differs: an edge set and a cache age exist only on a dataset node,
  `⤢`/`⇥`/`?` only on one with a result to open. Hand-written, which is `LEGEND`'s exception (a lesson,
  not an inventory) — but the run states are `STATE_GLYPH`/`STATE_TEXT`, and `anatomy.test.ts` holds
  every glyph and `title` against `CodaNodeView`'s source, since a renamed button leaves a guide
  describing a control that no longer says that and nothing breaks. **Labels are authored, boxes and
  the wire are measured**: where a label goes is a composition, where a *box* goes is a fact about an
  element, and one typed out drifts on a font fallback, pointing an inch under the button it names.
  Three traps. A box is a child of its callout so hover can light it with a selector, and a positioned
  callout is then its containing block — so the measurement needs the stage→item subtraction that was
  missing first. The section is **two boxes**: a canvas at the page's own column width, and the fixed
  world centred in it that is never stretched, since widening it moves every label off the part it
  names — the spare width goes to the canvas, the one thing here that means something when empty. **A hover panel is `visibility: hidden`, not absent**, so one hanging off the right of
  a right-hand label made the *document* 1130px wide in a 1024px viewport, at every width, with a
  scrollbar traceable to nothing on screen. And the breakpoint is asked of the **stylesheet**
  (`display` on the leader canvas), never restated as a `matchMedia` string: CSS places the labels and
  JS the lines, so a disagreement leaves labels round two cards pointing at nothing. Spliced in at
  build time on the appendix's route because the notes are *content*, and the fallback under it is the
  same words as a list. It also repaired the guide's `.node__head`, still `theme.css`'s fifth copy of a
  header tint the editor stopped drawing. See [docs/pages.md](docs/pages.md).
- **An output socket previews what is on it, and the hover is silent where nothing has run.** A
  port's value exists only once its node has, and hovering may neither fetch nor run (invariant 6),
  so the store is asked at the moment the delay elapses and a port with nothing cached keeps its
  `title` — an inferred-schema fallback was considered and refused, one gesture promising two
  different things being the half somebody acts on. That title carries **`Run this node to preview
  its output`**, gated on `needsRun`: silence alone cannot be told from a feature that does not
  work here, a tooltip appears at about a second where the panel opens at 260ms (so the line is
  read almost only where it is true), and `needsRun` is the card's own already-subscribed word for
  what a Run would change — annotation nodes excluded, they having nothing to compute. Nothing subscribes either: `getState()` per
  hover, not a selector per socket, since a sixty-node graph has a couple of hundred; the *panel*
  subscribes, a preview of a wire outliving a run being the one thing it may not show. Outputs
  only. **The target is the port row's side, not the 11px disc**, and the delay is 260ms against the
  thumbnail's 130 because a pointer crosses sockets on the way to the one it wants. Three
  dismissals: leaving, a **press** (a wire drag starting there — kept away by a ref until the
  pointer leaves, since a drag ending here re-enters with no leave), and the socket **moving**,
  which fires no event at all and so is a per-frame rect watch. All of it is **`useHoverPanel`**,
  shared with `NeuronThumbnail` — written twice first, forty lines matching token for token
  including the comments, and the watch is the piece where a fix used to reach one surface; each
  caller keeps only what is its own (a fetch to start and release, or a store read as `canOpen`).
  It opens **right** where the thumbnail preview opens left, which is one rule (open into the
  empty half) and therefore one function: `hoverPlacement` with a `prefer` side, neither caller
  flipping when that side runs out. Content: `describeValue`'s own line as the headline, never a
  second spelling — **and no fact may restate it either**, which is what makes layout, transform and
  layers headline-only and leaves a linkage the one thing that line says by omission (an uncut
  tree); a network is **two** captioned tables, geometry is its attribute table; every other kind
  answers *something*, or an unhandled kind is indistinguishable from not-run, with the
  headline-only set listed in the test rather than derived from the output. **The panel is
  pivoted** — columns down it, one row across — because which columns a value carries is what a
  reader cannot get elsewhere, and across the page a wide table spent its width on four of them
  (5 of 7 before, all 7 after, 8px shorter). **One value column, fixed**: spending the leftover
  width drew four on a narrow table, two on a neuron table and none on an empty one, one feature
  looking like three, and one is the count that always fits (408px of 416 at its widest) without
  cutting an eighteen-digit id, which invariant 8 says is then not an id. An empty table keeps the
  column and draws it **blank, not a dash** — no first row to be absent from. A **matrix keeps
  four and is not turned**, being a grid already whose single column would say nothing, which is
  what `fitCount` still guards and why `PreviewTable` carries a `fieldNoun`. **The head names all
  three** (`column · type · first row`) off that same noun, pivoted rows being otherwise three
  unlabelled things; and the footer counts **fields only** — a "+N more rows" there read as
  counting the fields and said nothing the headline and the head had not. `MAX_FIELDS` (24, halved
  for a network's two tables) is the height bound. **The fit is in the builder because the panel
  counts what it drops** — `max-width` plus `overflow: hidden` clipped a sixth column of digits
  under a footer reading "+1 more columns" — with the probe asserting no overflow on *either*
  axis, since a field list has a `max-height` over it. `pnpm probe:port-preview` is the browser half: 349px and 11px type at both
  0.659× and 0.243× is the transform question, the hit test at its own centre is `.coda-node`'s
  clip. See [docs/canvas.md](docs/canvas.md).
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
  its content and stacking overlapped on the first run; it opens with **every box ticked** and what
  is remembered is the **refusals** (`coda.wizardViews.v1`), because this question's options change
  with the analysis — a stored allow-list means something different every time it is read, and the
  reader who ticked *everything* under one analysis, having said nothing, would still narrow the
  next one to whichever members the two lists share. Absence is the default, so no sentinel.
  Every answer's row also draws a **node's** glyph, declared for a start or an analysis and read off
  `VIEWS` for a viewer; a glyph fails silently *upwards* into the category drawing, so the tests
  assert every answer names a registered type and no two answers to one question draw alike.
  A generated workflow also asks the canvas for **one layout pass** on arrival
  (`arrangeRequest`, opt-out on the summary): the row `buildWorkflow` places frames at 40–70% of a
  canvas and one ELK pass frames at 52–92%, and it cannot be done in the builder because **only the
  canvas knows how big a card is**. It is a request from a *builder*, never a property of opening —
  `loadGraph` stands auto-layout *down* on every open, so it must run ahead of that branch rather
  than behind it — and it neither glides (nobody saw the arrangement it left) nor keeps the camera
  (the fit on open framed the row). Four traps. **It asks the ceiling, not the
  floor**, since a wizard answer is a *family* with no dataset id yet — the floor hid Morphology and
  NBLAST for all three CAVE families; the ceiling names only keys that *vary*, the node still reads
  the floor so a real absence lands a message, and the test asserts both directions **per backend**.
  **`capabilityOf` answers `true` for an unregistered source**, so anything enumerating combinations
  at module-init or SSR time must `registerBuiltinSources()` first. **A generated search is capped**
  (`SEARCH_LIMIT`, auto-run being on; `GEOMETRY_LIMIT` on a morphology search, a skeleton node's
  `Limit` being a warn threshold, not a cap). And `demoWorkflow()` is what the tour's empty canvas
  and thirty test files load, so the suites exercise the graph that ships.
  See [docs/wizard.md](docs/wizard.md).
- **The wizard's first question has a fifth kind of answer, and the mode is derived from it.**
  **Multiple datasets** replaces that question with a multi-select and the other three follow
  unchanged, offering four cross-dataset analyses — `Compare Connectivity`, co-clustering,
  morphology in one space, NBLAST across datasets. `WizardAnswers.datasets` is a **list at every
  arity** and `isMulti` reads its length: a `multi` flag beside it is a second answer to a question
  the list already answers, and one written without the other is a `Match Cell Types` with a single
  input. The two analysis lists are **disjoint** and gated per *chosen dataset* rather than per
  first one, which is `available` generalised; a template space is a **second gate**
  (`requiresTemplateSpace`), not foldable into `SourceCapabilities`, because a space is a fact about
  coordinates bound to a dataset id. The third question is the one that can come back **empty** —
  two connectomes sharing no capability share no analysis — so it is a refusal on Continue with the
  reason beside the counter, and the arity ceiling is **read off the two nodes' `datasetCount`**.
  Three silent failures. A chain's ids are local to it, so two datasets each carrying one mint two
  `join`s and `assembleGraph` keys by id — `prefixChain` rewrites a **whole chain** rather than
  threading a prefix through its three readers, the first dataset keeping bare ids; FlyWire and BANC
  both call a card `annotations`, of different types, so the test asserts the *type* at each id.
  Every dataset meets on **one variadic `Stack Neurons`**, which is what retired the chain of
  two-input ones: a stack throws on a source column an input already has, so the levels could not
  share a name, and the 3D scene had to colour by the **outermost** — a run-time error no
  inference can see, still pinned directly. The table stack adds none at all, `Qualify Ids` having
  put the dataset in the id. And `DATASET_ROW` (3) is **not `ARM_ROW` (2) raised**: the extra row is the Description
  companion 300px below each dataset node, which a head-clearance band put on top of the *next*
  dataset — found at four datasets, invisible at two. `DatasetFamily.typeColumns` pre-fills the
  mapper's pickers (decision 3's "a default a reader can see", not a source capability), and
  **absent means nobody judged** — minnie65 has no typing, BANC's names come from its own pivot.
  See [docs/wizard.md](docs/wizard.md), [docs/datasets.md](docs/datasets.md) and
  [docs/comparative.md](docs/comparative.md).
- **The fourth guide has no steps, and its labels are placed rather than authored.** The Screen
  Map boxes every control on the shell at once and hangs a one-sentence label off each — a tour
  walks and this one *waits*, which is the right shape for "what is all of this" and the reason
  closing it is what earns the checkmark: there is nothing to abandon half way through. It is
  `nodeguide/anatomy.ts` pointed at the shell, and the difference is the whole engineering
  problem: that figure places eighteen labels **by hand** against a world that never stretches,
  this one labels the running app at every width, so the placement is computed and is the part
  that can be wrong with nothing failing — a label two pixels over the button it names renders
  perfectly. Hence `mapLayout.ts` is **pure over rects handed in** (jsdom lays out nothing, so a
  component test could only assert a label exists) and `pnpm probe:screen-map` asks the same
  properties of a real screen. Four measured findings, three of them wrong first: a row is
  **filled sideways before it is dropped** (labels 176px wide on buttons 34px apart put one label
  per row and a band **567px deep on a 1000px window**); a next row is a label's **own height**
  down, not `STEP`, or five of six candidates are positions the collision test throws away; the
  band is **the row, not the side** (`bandFor` — one band per side lets a lone `below` spot
  elsewhere drag every label down to it); and the lattice **can be full while the window is not**,
  so `sweep` appends every position there is room for, nearest first, and the last resort is the
  position that collides *least* rather than the last one tried, which on a distance-sorted sweep
  is the opposite corner. Nothing is ever dropped — a map that stopped labelling a control would
  contradict its own claim. Three more: **a spot that is not on screen is not on the map**, which
  is the feature (a control folded into `⋯` has no box), and `screenMap.test.tsx` mounting the
  real `App` is what stands between a renamed anchor and a hole; **hovering either end of a leader
  lights the triple** and dims the rest, which is what the leaders are *for* — tied by `data-spot`,
  since lighting the right number of things while pairing them wrongly looks right in a
  screenshot, with a **region lit from its label only** (a box the size of the window means the
  pointer is always on something) and the rule placed **below `.smap__label`'s own**
  `pointer-events`, which it overrides at equal specificity and which jsdom cannot see; **React runs layout effects
  child-first**, so the stage is held back one commit or it measures before the borrowed inspector
  exists — 15 boxes against 16, with every spot resolving when asked afterwards; and
  `isTourActive()` counts it, needing the guard **more** than a tour does, since driver re-reads
  its element's rect and this has measured every box once. Below `NARROW_QUERY` it stands down to
  a **list**, `nodeguide.css`' answer to the same problem: a map with invisible holes in it is
  worse than a list. What it must **not** do is re-derive what a guide already knows: `byTour` and
  `TOUR_ANCHORS` are `anchors.ts`' because importing them from `steps.ts` put the Guided Tour's
  whole step prose in the main chunk (verified against a build), and borrow/restore/`ensureGraph`
  are `guideState.ts`' because `tour.ts` cannot be imported by anything outside the driver.js
  `import()`. See [docs/ui-shell.md](docs/ui-shell.md).
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
- **A row that does not wrap does not clip — it moves the whole page, and only on a phone.** The
  toolbar's 21 controls come to **973px** of min-content width and it had no `flex-wrap`, so the
  *document* was 973 wide; a mobile browser answers that by zooming out to fit — 412/973 = **0.42**
  on a Pixel 7 — and every reported symptom is that number. The app fills the **top 42%** of the
  screen (visible area 973 × 2161 against a `100dvh` shell of 915), and the status bar is 412 wide
  under a toolbar painting to 973, because it spans the *tracks* while the row overflows them. It
  reads as a broken layout. **A desktop browser cannot show it** — at 412px a window has a scrollbar
  and no minimum scale, which is why the responsive dev tools were "much better behaved" — and
  neither can jsdom, so the measurement is `pnpm probe:mobile` (Chrome over CDP,
  `setDeviceMetricsOverride`, no dependency) and the property is **the document is never wider than
  the viewport**. Below `NARROW_QUERY` (`max-width: 720px`, **width only**, since a short desktop
  window has all the width it needs) the row keeps the document menus, Run and `⛶` and folds the
  rest into `⋯`: 973 → 412, one 42px row, 845px of canvas. The threshold is **TypeScript, stamped as
  `data-narrow`** — a stylesheet cannot import a constant, and the two halves disagreeing by 40px
  hides controls nothing put in the menu; the rule that survives is **a plain media query wherever no
  React branch is paired with it, the attribute only where one is** (`editor.css` writes its own 720
  for the shortcuts dialog, and is right to). Three rules from the fold: a control's **`label` is its
  menu row *and* its accessible name** (two fields is how a control gets two names, and `title` is
  the *tooltip*, which is a poor thing to hear read aloud); what stays out of the descriptor table is
  decided by the **shape a menu row can take**, never by holding state — the bell keeps its
  `useState` and still builds a descriptor, where written out by hand it was a third copy of both
  renderers; and the **Connections trigger had to leave `SourcesPanel`**, because the menu unmounts
  on the click that opens the dialog. Chords come from **`shortcutKeys`**, never typed — a table
  built by hand is exactly where `⌘Z` gets advertised to Windows. **A submenu opens right, else left, else
  *under* its row**, and the third answer is not a phone rule: a 260px panel beside a 260px one is
  520px, so a *flip* is a choice between two impossible positions and it picked the worse —
  `New ▸ neuPrint` at **-229** on a 412px screen, against 135 past the right — while the same two
  answers put an iPad mini's flyout at **-27**, off screen in the wide shell with no phone
  involved. So placement is **measured** (`submenuPlacement` over `useMenuFit`, a pure function
  the jsdom suite can pin) and `narrow` only short-circuits it. Hover inverts with it: inline, the
  row is a **toggle**, because "opens and does not toggle" holds only while something else — a
  pointer, focus — has already opened it. A **top-level** menu is *nudged* rather than
  re-anchored (`menuShift`), the same two-answer failure one level up — `Save` at **-110** on a
  412px screen against 52 past the right, where the panel fits perfectly well at 89 — and it must
  measure **`documentElement.clientWidth`, never `window.innerWidth`**: on a phone `innerWidth` is
  the visual viewport at minimum scale, so a panel hanging off the right widens the document, the
  browser zooms out, and the number grows to include the overflow being measured. That shifted
  `Save` by 8px instead of 60 and looked like the fix not working. An open panel takes the **screen**, not a 320px
  column beside 92px of canvas — off `--inspector-width` and off **stamped attributes, never
  `:has()`**, so "both open, the inspector wins" is a selector rather than a fact about source
  order. What none of this touches is **touch**. See [docs/ui-shell.md](docs/ui-shell.md).
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
- **A run state is derived, and boot was the one path that never derived it.** `refreshStates`
  compares each cache entry's key against the one the graph now wants, which is why `loadGraph`
  and `switchDocument` both end in one; the store's initialiser did not, so a reloaded workflow
  came up **all `idle`** — the one state `useStaleCount` ignores — i.e. a disabled Run button on a
  graph with no results, beside a status bar saying *up to date*. **The canvas had been hiding it
  by accident**: React Flow measures its cards on mount and that commit runs `afterGraphChange`,
  whose last act is the refresh, so only a route that opens *without* a canvas could show it —
  `DashboardLayout.open`. Two rules from the fix: **nothing in the store's initialiser may notify
  the host** (zustand assigns state from what the initialiser *returns*, so a `set` there is handed
  `undefined` and `onStateChange` throws on `s.graph`) — which is answered by *position* rather
  than a readiness flag, the derive sitting after `createDoc` and **before `activeDoc` names it**,
  where the `activeDoc !== id` guard every host callback already carries does the work; and
  **deriving is not running**, since starting queries at a shared server because somebody reloaded
  a tab belongs to auto-run on the next edit. `refreshStates` also **skips its key pass on an empty
  cache**: the keys have one reader, a freshness test against a `cached` that cannot exist, so at
  boot every one is hashed and discarded — milliseconds before first paint for a stored Explore
  selection near `SELECT_ALL_WARN`, whose `serialised` WeakMap is cold. The general shape is
  worth keeping: a second surface is how you find out which invariants the first one's side effects
  were quietly maintaining. See [docs/persistence.md](docs/persistence.md).
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
  run **underneath** a mounted grid, the one order that can see it. Last, **a run's denominator is
  its *scope***: the grid draws values rather than badges, so it is the one surface with no run
  indication, and the bar it grew reads `Scheduler.runProgress()` — `resolveScope` being the only
  thing that knows a cell's `▸` covers three of four nodes, where a stale count would stop at 75%
  with nothing wrong. A loop is **not one step** (its region's share grows per pass; nesting is
  read off the `iteration` `runNodes` already carries, a depth field needing a `try`/`finally` and
  a wrapper to survive nine early returns), a **failed** node is as far behind you as a successful
  one, and the bar lives in the *header* — `--dash-row` is measured, so 3px in the column resizes
  every cell twice per run. Three things found by building it. The ordinary walk **announced
  nothing** between a run's start and its end, against the store's own comment, so the badges
  arrived all at once. Fixing that on `onStateChange` is the **expensive** spelling — it walks the
  whole graph for observed schemas and its only guard is `looping`, false for the entire top-level
  walk, so a step per node is `scope.size` walks per run, worst on the auto pass that fires per
  keystroke and shows no bar at all; hence **`onRunProgress`**, a third channel doing the least a
  host can do, with a loop pass publishing but not announcing and an unmoved number keeping its
  old snapshot. And `useRunProgress` returns the Scheduler's own object, since a selector minting
  `{done, total}` is an infinite render — which is what the stubbed test does until it is given
  one. The bar also **pulses while determinate**, since length alone cannot be told from a hang, and
  `min-width` is the ring's own "a zero-length dash draws nothing" floor — a *drawing* floor,
  `aria-valuenow` still saying 0. A step is also **not the smallest unit**: the node currently running folds in its own
  `ctx.progress` fraction (`countRunning`), raised-never-lowered within the node and **top-level
  only**, since inside a loop the region's share already speaks for the body and the begin node's
  `progress` *is* that share — `iteration` is the guard, the same value `countSettled` reads.
  `coda-pulse` is one keyframe at **one** depth for all three
  callers: a shallower swing for the wide bar was taste, it was reported as invisible, and the
  numbers agreed — 0.72 puts the two ends **1.49:1** apart, under the 3:1 floor, against 2.33:1 at
  the ring's 0.4. Two consequences worth keeping: the parameterisation that taste justified went
  with it, and because the dip is toward `--surface-3` rather than toward a second colour, one
  number serves both themes to within 0.03 — but nothing can make the swing obvious *and* hold the
  trough at 3:1, since full strength is only 3.84:1 to start with.
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
- **`Find Neurons` asking nothing answers nothing, and that decision is at the node rather than at
  the seam.** No rows and no region means no neurons — not the dataset, which is what it used to
  mean and what put an unbounded `MATCH (n:Neuron)` on a freshly-dropped card. One layer down an
  empty `FindNeuronsRequest.rows` still means *no narrowing*, because `neuronIndex` and Explore's
  whole-table fetch reach the same method: a source that learned this rule would break both. So
  `asksNothing` (`nodes/lib/findNeuronsRows.ts`) owns it and **four surfaces read it** — `evaluate`,
  the card's foot line, and both emitters, which write an empty frame rather than a cell fetching a
  connectome the canvas never asked for. Two of the three controls count and only two: **`In ROI`
  does**, being a question that merely cannot be a *column*, so a rule reading rows alone answers a
  visibly-configured card empty; **`Limit` does not**, a cap being no statement about *which*
  neurons. It is not the old `Traced` default returning — that was a filter nobody chose, silently
  emptying the result where this narrows nothing and says so — and it is **not a guard rail**: nothing
  is refused, there is no wait, and there is nothing to raise, so `docs/limits.md` names it only to
  stop it being promoted onto a tier. The empty table carries the **dataset's own** neuron schema
  (`schemasForDataset`), or every column picker downstream empties on Run and reads as a broken
  dataset. Its one cost is paid in the wizard: Structured Search builds exactly this card, so
  `buildWorkflow` seeds a tautological row **on the synthetic dataset only** — the tour, the start
  page and every demo link show a workflow rather than ask a question, and an empty chain shows
  nothing. Separately, `FOUND_NEURONS_WARN` (10,000) fires **after** the fetch, a count not being
  knowable before one: an admission, not `warnOverThreshold`, and deliberately not `MAX_NEURONS`
  despite the shared number. **The five boxes it grew out of are deleted** — `typePattern`,
  `instancePattern`, `status`, `minSize`; `roi` stayed, being the one that could never be a column
  — and the *order* of the two changes is the load-bearing part: an alpha-era `.coda.json` holds
  four keys no definition declares, `normalizeParams` reads only declared params, so such a node
  asks nothing and therefore returns nothing **and says so**. Deleted first, the same file would
  have become a silent whole-connectome query. The fifty tests that wrote `{ typePattern: 'LC.*' }`
  say it in rows through `test/findNeurons.ts`'s `searchFor`, which emits *exactly* the rows the
  old fold did — which is why the export goldens did not move, the assertion that mattered while
  doing it. One casualty: the assistant could set `typePattern` and now faces `filters`, an `ids`
  param holding JSON, so `findNeurons.ts`'s `filtersNote()` rides on `ParamBase.catalogueNote`,
  **generated by reading `ALL_ROW_OPS` and `arityOf`** rather than transcribed — drift there is refused with a
  message about the *param*, which a model reads as "filters is wrong" rather than "that operator
  is gone". The other two `ids` params stay uncovered on purpose: one rule over "ids params" would
  be three grammars under one name. See [docs/nodes.md](docs/nodes.md) and
  [docs/wizard.md](docs/wizard.md).
- **A collection's attribute table is not the table that named its neurons, and `Carry fields` is
  the bridge.** Each source builds a geometry value's attributes from `SourceSchemas.morphology` —
  seven columns on neuPrint, three plus the annotation chain's on CAVE, two on a precomputed bucket
  — and `neuprint/schema.ts` argues why it does not follow the dataset ("derived from relationships
  and from `roiInfo`, not from neuron properties"). The Neurons input is read for *ids*. So a
  connectome publishing 48 properties handed `Split Neurons` seven fields, and the only route to the
  other 41 was filtering before the fetch, which answers a different question and costs a second
  fetch. The `columns` picker on `Skeletons`/`Meshes` (`nodes/lib/carryParams.ts`) joins them on at
  the node. Five rules. **The join is `core.join`'s, both halves** — `joinSchema` + `joinTables`, so
  duplicate keys annotate rather than multiply, the geometry's *items* order survives, and an
  unmentioned id keeps its geometry and carries a null. **A carried column wins its name *and keeps the old
  one's slot*** — `foldNodeColumns`' pair of rules, read by both halves so they cannot drift. The
  first is `networkMetrics`': `type_r` beside `type` gives a picker two answers and the second is
  stale, so the name is dropped from the left before the join rather than suffixed after. The
  second was got wrong first — an overridden column moved to the end, dismissed as something
  nothing reads, when `TableViewer`, CSV export and GraphML key ids are all `schema.columns` in
  order.
  **Empty hands the value back by identity**, so a graph saved before the param produces what it
  always did; the list *is* in the provenance key, and `geometryCache` absorbs the re-fetch. What it can carry is **what is on the neuron
  table already**: the port is `T.neurons()`, so neither a `Cut Tree` cluster table nor a
  `core.join` result can feed it — the latter because `joinTables` keeps its left kind at run time
  while `core.join`'s `inferOutputs` says `T.table` regardless, which is one line to fix when
  somebody wants it.
  **`onPartial` carries too**, or a scene coloured by a carried column draws nothing until the last
  body lands. And **no bespoke error for a vanished column**: `resolveColumns` drops it and
  `validateColumnParams` reports `Missing column(s)` at edit time, so the `ctx.warn` written first
  was unreachable *and* a second spelling. The exporters diverge again on the same seam — navis
  keeps attributes on the neurons, so Python emits
  `set_neuron_attributes(dict, register=True, na='propagate')` keyed by the same `astype('int64')`
  that named the bodies (a `str` key silently fills every neuron `None`) and **notes-and-skips the
  five names navis computes itself**: `type`, `cable_length`, `soma`, `nodes`, `connectors`, each
  measured by `setattr`; nat keeps a `data.frame` beside its neurons, so R writes
  `nl[, "type"] <- …[match(names(nl), frame$neuronId)]` with no restriction at all, and a carried
  column survives subsetting — the two features composing in the export as on the canvas.
  See [docs/nodes.md](docs/nodes.md).
- **A split is one pass, because two filters with opposite conditions are not a partition.**
  `Split Neurons` (`neuron.splitNeurons`) is **`Stack Neurons` run backwards**: it asks the attribute
  table a collection carries a set of Find Neurons rows and hands back both halves, so
  `source is hemibrain` takes a stacked scene apart on the column the stack itself wrote. The
  hand-built alternative is silently wrong — the negation of several ANDed rows is not one condition,
  so filtering the table for `type is LC4 AND side is left` beside `type is not LC4` drops the
  right-side LC4s from **both** arms, two plausible counts and nothing to say a population went
  missing — and after a stack or a transform there is no table upstream left to filter at all.
  The question is asked of the attributes and answered in **items**, which is why it is
  `sliceElements` twice rather than geometry code: bounds **recomputed** (a half claiming the whole
  box frames a viewer on empty space), `units`/`space`/`provenance`/`detail` **carried**. Four rules.
  **Skeletons and meshes only, and both exclusions are decisions**: `Points` is refused though
  `Stack Neurons` takes it, its attribute rows being *connectors*, and a table belongs to
  `Filter Table` — each refusal names its own remedy (`wrongKindReason`), which the card draws where
  it would otherwise draw a row count, and `isSplitKind` is a deliberate **fourth** kind list beside
  `isGeometryKind`, `isIterableKind` and `Collect`'s own. **No rows sends everything to `Rest`** — an empty predicate
  matched nothing, and the "AND over no clauses is true" reading makes a half-built card
  indistinguishable from a finished one keeping every neuron; sentence *and* predicate are one
  declaration each in `splitRows.ts` (`matchesNothing`, `nothingMatchesReason`,
  `unresolvedRowsReason`), since **four surfaces read each** and the card had been asking
  `stored.length` while the rest asked `terms.length`. The selection is **`partitionElements` in
  `iterables.ts`**, beside `groupOf`/`elementAt` — `groupOf` being a one-sided partition already —
  so `splitRows.ts` holds only what is about filter rows, `sliceElements` stayed private, and the
  identity fast path (a whole side handed back by reference) sits where the whole family can see
  it; `cheap` means a typed value re-partitions per keystroke and every intermediate string matches
  nothing, which now allocates one empty collection and no index array at all. `fieldTermsMatch`
  being an AND, a `terms.length > 0` guard is what makes no filters mean `Rest` and not its
  opposite. And **the exporters diverge because the
  libraries do**: nat keeps a `data.frame` beside its neurons, so R emits one condition into a
  logical vector both halves index (`nl[, ]`, `nl[mask]`, `nl[!mask]`, all run against a synthetic
  neuronlist), where navis keeps attributes on the neuron objects — `fetch_skeletons` attaches **no**
  connectome metadata and `NeuronList.summary()`'s `type` is `'navis.Skeleton'`, the class, so a
  `type` filter there would match nothing in silence. Both measured, not recalled; the Python cell is
  a registered emitter returning a TODO with the two real remedies rather than a `NO_EMITTER` entry,
  whose words are "no equivalent *yet*". The card is `FilterRowsEditor` + `FilterRowsFoot`, shared
  with Find Neurons and reading **`ctx.attributes('in')`** rather than `ctx.schema('in')`; the
  param's read *and* write are `nodes/lib/filterRowParams.ts`'. The props are the tell there: an
  extracted editor taking `fields` and `broken` beside `schema` leaves both cards deriving them and
  cannot enforce the "one analysis" property it claims. See [docs/nodes.md](docs/nodes.md).
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
- **A heatmap's rectangle selection is a set of positions, and "store the meaning, not the
  position" is the rule that had to bend.** Shift- or ⌘/Ctrl-drag selects, **alt-shift-drag adds**,
  ⌫ or a modifier-click clears, bare drag still pans (`ScatterViewer`'s division and React Flow's),
  expanded only. It was **labels** first, which is `chartSelection.ts`' standing rule and survives
  the Order and Filter tabs sitting on the same card as the gesture — and it was reported as a bug
  within the hour, because **a heatmap's names are not identities**: the Labels tab exists to
  replace ids with cell types, one-to-many by design, so a box round one cell of a fourteen-row
  `LC4` block selected all fourteen. The cost is taken the other way now and it is the smaller one
  — **a re-point is visible on the card the instant it happens**, where a name quietly widening a
  selection is visible nowhere and reaches `Selected Rows`. The general half: that rule assumes the
  mark *has* a unique meaning, and a viewer whose job is renaming is where that stops holding.
  **One param, both axes** (`r:`/`c:` prefixes, sorted so a re-selection that changed nothing does
  not move a key; a non-integer is dropped, which is what a label-era selection degrades to),
  because two params are two commits and an undo would take back the columns and leave the rows
  (`attachEdgeSet`'s trap); the two *outputs* stay separate, a row and a column being different
  populations downstream. Adding is a **union, never a toggle** — a toggle over a folded block
  standing for a hundred lines has a result nobody can predict. The drawing is **bands, outlined
  never tinted** (colour is the data), rows spanning the width and columns the height — a cross
  rather than the box dragged, honest since the two leave as two lists. **`label` and `relabel` are
  two columns** because the Labels tab spends the axis's identity, and keeping them aligned is why
  `evaluate` carries the *arrival* names through the filter and the sort on the identical index
  lists — `orderIndices` hands back lists rather than a matrix for exactly that. Seven properties only a
  browser shows (`pnpm probe:heatmap-select`), and **two of them were the probe's own arithmetic
  first**: the band check read by *shape* passed against the column band, which spans the plot's
  whole height and so contains every row tick (`data-axis` tells them apart); and the count check
  compared tick centres strictly inside the box, 10 against 9, where `linesInRect` takes every line
  the box *touches* — the near-miss that invites a tolerance instead of the right rule. **It also
  exposed two real exporter bugs.** The Order tab emitted *label* indexing, correct only while axis
  labels are unique — on a 3×3 with two `LC4` rows **pandas returns five rows** and **R silently
  drops one**; positional now in every arm (three got *shorter*), with `coda_follow_order` for the
  rule a comprehension cannot state (the first **unclaimed** line of a repeated name wins, where
  `intersect`/`setdiff` de-duplicate). And R's selection helper owns the **0-based/1-based seam**
  at both ends — positions in, `index` out — where the trap is the *type*: `picked` arrives as R
  numerics, so without an `as.integer` that column is a **double**, which a join downstream reads
  differently from the canvas's. `probe:r-helpers` caught it, on a change made to shorten the line.
  Last, because the key forces it: **a selection in the provenance key means the reshaping has to
  be memoised** (`SHAPED`, `editTable.ts`'s `PLANS` idiom, warnings cached and replayed) — the
  bill is not the filter but `runClusterOrder`, which crosses the Pyodide bridge and caches
  nothing, so a drag on a clustered heatmap re-clustered it once per gesture; and it holds the
  matrix's *identity* steady, which is what stops the viewer rescanning and re-folding four
  million cells to redraw the picture already on screen.
  See [docs/viewers.md](docs/viewers.md) and [docs/nodes.md](docs/nodes.md).
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
  **the flag saying a drag happened is a ref, not state**, or `pick`'s identity changes and every
  bracket re-reconciles on each pointer move; and **pointer capture is taken at the slop, not at the
  press**, because capturing from `pointerdown` sends the `click` to the capturing element and
  selection silently stops working the moment anybody zooms in. All three are **`usePanGesture`**'s
  now — shared with the ROI viewer, which is what extracted them — and the hook swallows that click
  itself in the capture phase rather than handing a caller a ref to remember. The wheel is **`useWheelZoom`**, shared with the heatmap. Everything the
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
  **beside** the `<text>`, not inside it. **The Heatmap has the same port and it is the opposite kind
  of thing**, which is the pairing to read together: its axis labels are *data*, matched by the Filter
  tab and sorted by the Order tab, so a presentational rename there would show `LC4` while a filter
  typed `LC4` matched nothing. `displayLabels` is shared and each caller decides what the answer is —
  drawn there, written into the matrix here, ahead of both tabs, `NBLAST`'s `Label by` being the
  precedent. What that spends is the identity this port exists to keep, one node further down
  (`Linkage → Selected to Neurons`), which is why it takes a wire and why the help says a Linkage
  needing ids goes *above* it; a separate `Relabel Matrix` node was the rejected third spelling.
  No `Unmatched` control either — blanks on an axis collide and the Filter box could no longer address
  them — so an unnamed line keeps its label and the **count** is what is said, in two messages that
  are two states (*none* named names the two controls that fix it, *some* named is a count). Both
  exporters write into the pass-through, which is where they diverge from this node's: pandas needed
  **`set_axis` and a rebind**, since `heatmap = similarity_matrix` is one frame under two names and
  `df.index = …` renames the upstream variable. Last trap, found by **running** the
  emitted cell: pandas' `dropna` keeps the empty string, so an untyped body drew a blank leaf in the
  notebook where the canvas drew its id — **the join the emitters do is `coda_relabel`**, the helper
  `core.relabel` already emits, because hand-rolling it on `.astype(str)` matches *nothing* when an
  `i64` column with one null becomes `float64` and prints `'101.0'`.
  See [docs/viewers.md](docs/viewers.md).
- **An embedding is a k-NN graph laid out, and the three ports are three ways of writing one down.**
  `core.embed` is UMAP, and it is **JavaScript** rather than the eighth Pyodide capability because
  `umap-learn` needs numba and the pinned v314.0.5 lock has none of numba, llvmlite, pynndescent or
  umap-learn in its 356 packages — sklearn *is* there (t-SNE, PCA, MDS, all `metric='precomputed'`)
  for **scipy's 14.0 MB plus 4.4 MB**, which is what would end the seven-identical-rows property in
  `MODULES`. So `src/umap/` is a second compute backend in the same boundary group, dynamically
  imported, 30.5 kB gzipped in its own chunk. What it costs is a claim nothing here can make: two
  UMAP implementations do not agree cell for cell and neither do two seeds of one, so **`Seed` is
  what makes invariant 4 hold without a nonce** — and what lets the Annotations pickers be *data*
  where `out.dendrogram`'s are presentational, since the label leaves this node in a table a Scatter
  colours by. `Matrix`, `Features` and `Neighbours` converge on one adapter set: **more than one
  wired is refused rather than ranked**, and the **`Features` port is a convenience, not a scaling
  win** — it builds the n² here, and only `NBLAST k-NN → Neighbours` escapes it (densifying is not
  an option: umap-js takes `number[][]` and Partner Vectors by partner id is 100k features wide).
  Two library conventions fail silently and are checkable from nowhere inside: **row `i` names
  itself first at distance 0**, because `smoothKNNDistance` sums from index 1 as umap-learn's
  `smooth_knn_dist` does, so `k` real neighbours with no self drops the closest from every
  bandwidth search; and **every row is exactly `k` long**, padded with `-1` — which the library
  already skips and which is the value `knnTable` drops on the way out of NBLAST k-NN. A padded
  *distance* is the row's own furthest, never infinity, which would make the row's mean infinite.
  `transformFor`/`checkLinkageDistances` are reused verbatim: UMAP embeds negative distances as
  happily as fastcore clusters them. Output is `label`/`umap1`/`umap2`/`annotation`, constant
  (invariant 3) and keyed `label` so **`Embedding ⋈ Cut Tree`** needs no configuration. It cost
  `out.scatter` a fix: `resolveColumn`'s rule 3 gave *both* axes `umap1` and the node's own check
  counted numeric columns instead of asking what the pickers resolved to — fixed there rather than
  in `resolveColumn`, whose fallback `scheduler.ts`' cache-key pass would have to re-spell.
  Both exporters emit the **reference** (`umap-learn`, `uwot`) with a NOTE, and all four call
  shapes plus both `coda_umap_knn` helpers were checked by **running** them. Last, the general
  half: **optional input ports normally compose, and these do not** — every automatic wiring pass
  here fills each port with a compatible source, which is right for Connectivity's `neurons` and
  `labels`, so the node guide's demo builder wired all three of these from one neuron table and
  the "Open in a workflow" link opened on the node's own refusal. `PortDef.exclusiveGroup` is the
  declaration, read by `wizard/demo.ts` and rendered in the assistant catalogue — a *declaration*
  and not a canvas constraint, since a second wire is where `validate` can say which port to
  disconnect and why; `demo.test.ts` holds it for every node rather than for this one.
  See [docs/nodes.md](docs/nodes.md) and [docs/python-pyodide.md](docs/python-pyodide.md).
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
- **A profile's subject is a neuron or a group of them, and the grouped answer is the ungrouped one
  folded.** Neuron Profile's `Group by` is a **column picker, not a `Show types` boolean** — a boolean
  has to name `type`, which is the one thing that card's own rule forbids, and the picker also buys
  hemilineage, class, a `Cut Tree` cluster and `Match Cell Types`' shared label. It stays
  **presentational** because a **pin resolves the group to member ids at pin time**: `selection` is a
  list of neurons under both modes, so `evaluate` is untouched and `Current` gains no second meaning.
  `profileStats`' subject layer partitions the fetched table by member and runs the *same*
  single-neuron roll-ups per part — reimplementing them over a grouped table is how the untyped
  bucket, the `>= minWeight` boundary and the nested-ROI filter come to disagree while still drawing
  a plausible bar. **Absent is a measured zero**, inverting `groupByTable`'s null rule on purpose (the
  fetch enumerated every partner of every member), which is why `Aggregate.present` rides beside
  `mean` — 4 across thirty cells where two connect is a different fact from 4 where all thirty do.
  The two measurements that *are* unmeasured when absent, a transmitter probability and a table
  attribute like `size`, say so where they are computed. `sd` is **null below two members**, never 0.
  Above `MAX_AUTO_MEMBERS` a subject is **deferred, not refused** — one banner, per subject, because a
  column picker puts `status` one mis-click from querying a whole connectome between two page turns.
  The exporters fold too — **Python over every frame, R over the partner frames only**, because
  neuprintr hands back the nested `roiInfo` and leaves the primary-ROI filter to the reader, so a
  mean over it would average double-counted totals; each says so where it diverges. All three
  implementations are pinned against the same three members by `pnpm probe:helpers` and
  `pnpm probe:r-helpers`. A grouped emit **widens a pin to the whole table**, since a pin under a
  grouping is one group's members. See [docs/widgets.md](docs/widgets.md).
- **A dataset that keeps its cell typing in a table needs a chain in front of it, and that chain is
  a declaration rather than a graph.** A neuPrint neuron carries its type as a property; a CAVE
  datastack does not, so browsing FlyWire without one is browsing eighteen-digit root ids. **Two
  families need one and they differ by a factor of six** — BANC's Codex annotations are already in
  the datastack, so one pivoted CAVE table does it; FlyWire's current annotations are a file
  published elsewhere and its community tags a second table, so six cards in two arms meet at a
  Join. Both were written once as `examples/starters.ts`' bespoke starters and **stayed there**, so
  one dataset answered one question two ways depending on the menu you came through: `New ▸ FlyWire`
  opened it typed, the Workflow Wizard opened it on root ids, and the assistant — catalogue
  generated from the registry — could not know the chain existed and emitted a lone dataset node
  every time. `DatasetFamily.annotationChain` is now the one declaration and **only the origin and
  the step belong to the builder** — that line was first drawn at "placement", and both builders
  promptly invented structure the declaration knew and did not state, the wizard's version filling
  column-major and *interleaving the two arms*. A row is a fact about the chain, a step is a fact
  about a canvas; `chainGrid`, `chainLinks` and `foldChain` are where the rest lives, since how a
  chain attaches and that it folds are not placement either. Four rules. The catalogue note is **generated** from it
  (`datasetChainNote` into `NodeDefinition.catalogueNote`, the sibling `ParamBase.catalogueNote`
  had been missing): **0/5 → 5/5** on `gemma4:31b-cloud`, on *both* families — a one-card chain is
  not the easy case it looks, since without the note the model never reaches for the table at all, and a prose draft saying *"wired in that
  order"* was wrong, this being two rows meeting at a join rather than an order — rendering from
  `links` is what stops that twice. Two members is also what keeps it honest — the tests are asked of every family
  declaring one, and `foldChain`'s "a single card is left unfolded" rule exists because BANC asked
  for it. It is **not baked into the node**: two of FlyWire's six are `expensive` and a third reads
  a ~1M-row table, so a dataset node doing that silently is
  un-inspectable, where folded into a frame it buys the same first screen hiding nothing. **A demo
  build leaves it off, except where the demoed node *is* the dataset** — both halves found by a
  test. The node guide ranks candidate workflows by inference issues, six more cards are six more
  ports to fit cleanly on, so `core.filterTable`'s demo link silently moved to FlyWire — a 139k-row
  download, that million-row table and a token prompt, to demonstrate filtering a table; cost is not
  an inference issue. But off *everywhere* is wrong the other way, since a dataset node's demo is
  the graph the wizard would have built, so `dataset.flywire` opened a bare card beside prose saying
  otherwise. The argument belongs to the **append** branch, not the containment one (`ownDataset`).
  And **the reason lives on the chain** (`AnnotationChain.why`), or a note saying the built-in
  typing is stale outlives the chain that replaced it. See [docs/datasets.md](docs/datasets.md)
  and [docs/wizard.md](docs/wizard.md).
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
- [docs/assistant.md](docs/assistant.md) — the AI assistant: what the model is told and what each
  line of it cost to learn. **Read before touching the prompt.** The organising rule is
  type-versus-instance — the catalogue is the cached prefix and gets facts about a node *type*, the
  graph listing gets facts about a node *as wired* — and a fix on the wrong side measures as no
  improvement at all. Also the live findings with numbers behind them (naming the input a
  picker reads, 10/10 against 5/10; probing `visibleIf` to say what switches a param off, 0/20
  against 1/10), why there is no tool loop, and why five runs per side is the floor for judging a
  prompt change. Two rules from the third finding, which is the one that generalises: **a fact the
  model has been given is not a fact it acts on** — `PortDef.producedBy` says which node fills a
  port only that node can fill (`isAssignable` ignores schema, so `Table{?}` at both ends hides
  every pairing), and the *same fact* measured 0/5 as a declared port schema, 0/5 as a `[from …]`
  tag on the port line and 1/5 inside `def.guide` at +35k characters, against **7/10** as a whole
  sentence on its own line saying what to do. And **a legal plan can be a wrong one**: `applyPlan`
  checks types, ports, params and cycles, so a neuron table wired into a Labels port is accepted,
  which is why `runTurn` previews each plan and hands back what it leaves on the cards. That list
  is **`ApplyOk.warnings`, already computed** by the `applyPlan` the preview just ran and already
  scoped to the nodes the plan *touched* — a before/after diff of two fresh inferences was the
  first shape and was a second spelling of `collectWarnings`, drifting from it on how a node is
  named and on whether `severity` survives. Only `aboutColumns` issues are dropped, `RULES` having
  already excused them, and the plan is **held rather than applied** so the turn is still one
  commit. That round measured **6/10 against 6/10**; it ships for the wire nothing refuses, and
  wants re-measuring on Sonnet.
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
  `src/help/nodes/`, and the figures that draw real registry objects. **Read `## Voice` before
  writing or editing one** — the corpus was cut 34,060 → 28,528 words once and the five things
  that were in the way are recorded there, along with the rule that a **callout is for behaviour
  a reader would not predict, never for a design decision**. Two ways to mistype a callout marker
  render as ordinary text and are invisible in the parsed document, so `help.test.ts` checks the
  raw source.

Two notes cut across all of them. **jsdom performs no layout and has no WebGL**, so anything
about geometry or pixels must be driven in a real browser. And **every measurement here was
taken, not estimated** — re-measure rather than reasoning one forward.
