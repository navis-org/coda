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

1. **`src/core` and `src/data` are headless.** No React, no zustand, no store, no UI
   imports. Enforced by a lint rule in `eslint.config.js`. The reason is a future
   non-React consumer, plus DOM-free unit tests.

2. **`inferOutputs` must never throw and must not fetch.** It runs on every graph
   mutation; failures degrade to "unknown type", which silently kills column pickers.
   Because it reads whatever is cached, something has to say when a degraded answer is
   worth redoing: fire `reportSourceLearned` for anything inference reads synchronously.

3. **Schema half and value half must agree, and sit side by side.** Every op that shapes its
   output has a `*Schema` and a `*Table` function adjacent to it (a row-only op — filter, dedupe,
   sort, sample — passes the schema through and has none). If they disagree, downstream column
   pickers break only after a run. What matters is **adjacency plus an agreement test**, not one
   file: `src/nodes/lib/tableOps.ts` is the usual home, but a pair bringing its own vocabulary may
   live in a focused sibling module carrying its own sweep (`nodes/lib/matrixReduce.ts`).
   `tableOps.test.ts` is hand-written per op rather than a registry sweep, so nothing catches a
   pair that is simply never checked anywhere.

4. **Cache keys are provenance, not content** — `hash(type, params, upstream keys)`. So
   `evaluate` must be deterministic; hidden mutable state needs an explicit nonce param.
   `normalizeParams` excludes hidden (`visibleIf` false) and `presentational: true`
   params. Mark a param presentational **only** if it cannot change what `evaluate`
   returns — getting it wrong means a stale result silently survives an edit. A declared
   param nothing stored reads as its declared default in every context (`withDefaults`), so
   read `ctx.params.x` plainly — a `?? literal` beside it is a second copy that drifts — and ask
   `visibleIf` through `visibleParams`, or the inspector and the key disagree on an old graph.

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
   neuron* with nothing to say so. One definition each in `src/core/ids.ts` — `NeuronId`,
   `isNeuronId`, `idText`, `compareIds`, `numericId`, `ID_COLUMN_NAME`, `isIdentifierColumn` —
   and deliberately **no re-export**, a shim being how a symbol acquires a second spelling. Each
   source converts at its own edge; geometry carries the id as plain `id`, a draw/export key
   rather than the identity. The UI is where this keeps being re-broken: never `Number(...)` an
   id. Two clauses to read in the doc before relaxing anything: the transport grammar is not the
   only one (neuroglancer's `parseUint64` is narrower, hence `isSegmentId` — a second predicate,
   not a second spelling), and **every source publishes one id dtype, `str`**, which replaced its
   own locally-right opposite so that a neuPrint + CAVE pair could be stacked at all.

## Gotchas found the hard way

The rule, then the doc that holds the incident, the measurement and the symptom — which usually
points nowhere near the cause. [docs/gotchas.md](docs/gotchas.md) is the general record; where a
rule belongs to one area, its record is in that area's doc.

### Cross-cutting — these bite in code that is not obviously "about" the area

- **A column picker keeps a chosen column rather than substituting.** A schema without a
  column is very often a schema that has not *arrived*. Substituting cost 9 GB once.
- **A picker on its own declared default still resolves before the schema lands**, and an
  unset *required* picker means its declared default. On an `optional` picker, empty is a
  decision and stays one. **A multi-column picker keeps an unseen list untouched.**
- **Both peeks start the fetch they cannot answer** (`peekDatasets`, `schemasFor`), once per
  instance, or the first Run of a session behaves differently from the second. **A peek whose
  fetch needs a credential is gated on having one**, and re-armed by the credential *changing* —
  an ungated peek puts an auth failure in the status bar at somebody who has only dragged a node
  onto the canvas. A per-account listing is not reusable across accounts.
  See [docs/backends.md](docs/backends.md).
- **A node whose output size is the product of two independently-resolved columns needs a
  ceiling checked before allocation** — neither picker knows what the other did.
- **A guard rail warns; it does not refuse.** A refusal claims there is no useful answer,
  which for a count is almost never true. `ctx.warn` is the channel; `CRASH_FLOOR_BYTES` is
  the only thing left that refuses, and only for an allocation. Time is never a refusal.
  A limit worth arguing about is stated in the units of the thing it protects.
  See [docs/limits.md](docs/limits.md).
- **An id has a history, and both halves of a node's saved state need to say so the same way.**
  Renaming a port or a param loses stored state in silence — an edge naming a port the node no
  longer has is dropped with a warning, and a param the definition no longer declares is
  *ignored* by `normalizeParams`, so a label somebody typed reverts with nothing said at all.
  Hence **declarations of one shape**: `PortGroupDef.formerIds` (positional),
  `ParamBase.formerId` (singular) and, for a renamed *type*, `NodeDefinition.formerTypes` — all
  read at load and all **only after the live id has missed**. The param half also carries
  `absentMeans`. `registerNode` refuses the ambiguous cases. Deliberately **not** a per-type
  migration table in the loader. See [docs/nodes-tables.md](docs/nodes-tables.md) and, for types,
  [docs/packs.md](docs/packs.md).
- **A param added to an existing node type has three states, and a card can only draw two.**
  `defaultParams` writes a default at *creation* and never runs over `deserializeGraph`, so a
  stored node without the key was written by a build that had no such control — not the same as
  the default, the moment absence means something *else*. `ParamBase.absentMeans` records the
  third state; deliberately not a general backfill. Other half of the trap: **a node with a body
  of its own draws no generic param rows**, and `compact` is always true for an on-canvas card,
  so gating on `!compact` means "inspector only". See [docs/datasets.md](docs/datasets.md).
- **A node this build does not have loads as a `core.missing` placeholder and is written back as
  itself.** Dropping it, the old behaviour, lost the card and its wires on the next save. It holds
  everything in `params` (the original params as JSON text, its ports read off the file's edges);
  `getNodeDef` answers for it and `allNodeDefs` never lists it; its error comes from *inference*,
  a `validate` line blocking nothing. **A new writer of graph JSON goes through `serializeGraph` or
  `fragmentBody`**, which spell it back via `documentNode`. Alongside: a registered definition is
  **frozen**, and a type id follows `core/nodeType.ts` — `pack:name` for a pack's node.
  See [docs/persistence.md](docs/persistence.md).
- **A pack switched off hides, never unregisters, and only what reads the offered hooks hides.** A
  surface offering nodes reads `useOfferedNodeDefsByCategory` (`useOfferedForNewWork` where it builds
  a new workflow); calling the registry directly passes every test and ignores the switches.
  Connectome's nodes keep built-in ids, so which pack a node is from is `packOfType`, never the id;
  a *new* node in any pack is `pack:name`, and a pack id is permanent. See
  [docs/packs.md](docs/packs.md).
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
- **The analytics path is a literal, and both gates matter.** `vite/goatcounter.ts` sends a
  literal per entry rather than `location.pathname + location.search`, and **pinning the path
  does not close the query string** — `count.js` sends `q` and `t` on every beacon whatever
  `path` is. The tag is `apply: 'build'` **and** gated on `CODA_ANALYTICS`, set only in
  `deploy.yml`: this repo is public and permissively licensed, so without the second gate a
  fork's readers get reported to a dashboard its operator never chose. There is deliberately
  **no event tracking**. See [docs/analytics.md](docs/analytics.md).
- **A page whose content arrives with the script is a page most crawlers never read, and a
  sitemap does not fix it.** So `index.html` carries a `<noscript>` hero — **not** markup in
  `#root`, which `createRoot().render()` clears — and `nodes.html` a **visible** static index of
  every node's prose, visible because hidden text keyed to a crawler is cloaking. `vite/seo.ts`
  derives its page list from `build.rollupOptions.input`. **`lastmod` is git's or absent, never
  a wall clock.** `SITE_URL` is deliberately **not** gated on an env var the way analytics is —
  the analytics gate protects a fork's *readers* from a third party, whereas a wrong canonical
  is contained within the fork. See [docs/seo.md](docs/seo.md).
- **A generated file that is committed must not carry a wall clock.** `ZooIndex.updatedAt` is
  the newest entry's commit date, not `Date.now()`, so `zoo-index --check` can byte-compare it.
- **A buffer handed to `callPython` is detached the moment the call is posted**, so read
  anything about it — its length above all — *before* the await.
- **`localStorage` is undefined** under Node 26 + jsdom. Tests use `clearStorage()` /
  `installStorageStub()` from `src/test/jsdomStubs.ts`.
- **React Flow needs measurements.** In jsdom, unmeasured nodes are `visibility: hidden`, so
  component tests pass `{ hidden: true }`. `installJsdomStubs()` supplies ResizeObserver,
  `getBoundingClientRect`, `matchMedia` and a 2D canvas context. WebGL stays absent on purpose.
- **jsdom has no `PointerEvent` and no pointer capture, and both fail as "the handler did not
  run".** Without the first, `fireEvent.pointerDown(el, { shiftKey: true })` falls back to a bare
  `Event` and every modifier, button and coordinate arrives `undefined`, so the handler takes the
  branch for a gesture nobody made; without the second, the `setPointerCapture` every drag here
  takes on the press throws *inside* the handler before the gesture is recorded. No error
  surfaces either way — the spy is simply never called, which reads as a broken component.
  `installJsdomStubs()` supplies both, which is what makes a gesture's *wiring* testable at all;
  its **geometry** stays the browser probes', jsdom laying nothing out.
- **`erasableSyntaxOnly` is on**, so no TS parameter properties (`constructor(private x)`).
- **Prettier owns `src/**/*.{ts,tsx,css}` and nothing else.** `pnpm format` is the one
  declaration of that scope, so `prettier --write .` is the wrong reflex: 111 files nobody asked
  for. Every `*.md` is outside it because prettier rewrites `*em*` throughout, burying the design
  records under emphasis churn; the recorded `__fixtures__/*.json` are outside it because they
  are verbatim wire responses. CI enforces the scope by running `pnpm format` then
  `git diff --exit-code`, deliberately **not** a second `prettier --check` script — two spellings
  of one scope drift into a guard that passes while `pnpm format` still rewrites the tree. One
  documented exception goes the other way: a `<!-- prettier-ignore -->` pinning each
  `<meta name="description">` onto one line, a wrapped tag being one `grep` reports missing.

### Canvas, cards and layout — [docs/canvas.md](docs/canvas.md)

- **A node's glyph is one drawing per type, and the table is data because a third surface has no
  React.** `ui/glyphs.ts`: drawings on eleven base shapes — the base shape names the material, the
  drawing on top names the operation. Four marks are shared and load-bearing (funnel = filtering,
  dashed outline = a user's selection, four-point spark = "cleaned", weight = role). Colour is not
  a channel; `currentColor` only. Primitives rather than JSX because `nodes.html` draws the same
  set with no React. Three silent failures, all pinned by `glyphs.test.ts`: a mistyped key compiles
  and serves the category fallback; scaling a dataset silhouette scales its stroke; the two
  renderers can disagree on `strokeWidth` vs `stroke-width`.
- **The canvas **+** unfolds rather than opening the browser, and every button in it is derived**
  from `nodeDefsByCategory` and `glyphs.ts`, so a node registered next month appears with no edit.
  A wrapping **band**, not a row; aligned to its button by measurement in a `useLayoutEffect`;
  `snakeRows` fills bottom-row-first in *order*, so DOM order stays alphabetical. Silent failures:
  a closed surface must be **unmounted, not hidden**; the animation must be `@keyframes`, not a
  transition; `column-reverse` draws the first child last; a node button needs a fixed height and
  **no** border. The prefix is `fab-menu` because `add-menu` is the *command palette's*, and
  `data-tour="add"` goes on the stack rather than the button, `tour.css` freeing the spotlit
  element **and its subtree**.
- **A card the layout must not place is condensed, never constrained.** ELK has no "directly
  below" constraint and no notion of an edge that is not a dependency, so a Description companion
  laid out as an ordinary node lands in the layer *after* its dataset, competing with the real next
  step. `layout/companions.ts` takes the companion out of the graph, **grows the host's box to
  cover where it will sit** (the silent half — withholding without growing leaves a card over
  whatever filled the gap), and snaps it back under the host's measured height. Grown as an
  **overlay** on the measurement map, never a `size` on the node and never in place. Three
  refusals: a companion carrying **any other wire** stays put, a second companion on one host stays
  an ordinary node, and a **negative offset declines**. Expansion **snaps**, inverting
  `expandPositions` on purpose. A **chain caption** is condensed the same way.
- **`arrangeScope` withholds every reference edge, and filtering at the scope is not enough.** A
  reference names a node rather than consuming it, so an annotation chain reading its datastack out
  of the dataset it feeds is a two-edge loop ELK must break at one end or the other. Excluded
  rather than reversed — reversing asserts a direction ELK then reserves a channel for. The half
  that shipped broken: `collapsedView` merges stand-ins from `graph.edges` rather than from the
  list handed to `condense`, so a withheld wire returns the moment an end is folded. `arrangeScope`
  **returns** its `omit` set, `condense` takes it, and `CollapsedEdge.merged` names the wires behind
  a stand-in so one is dropped only when **every** wire behind it was omitted.
- **A layer is a column, and the tightest layouts break that rule — so packing is a post-pass, not
  a fifth algorithm.** ELK layered spends a whole column on a card that is only ever a leaf and
  makes a graph as tall as its tallest column. The move a person makes is to put a card in its
  *predecessor's* column drawn below it, which is a layer violation **no ELK configuration
  produces** (swept, not assumed). `layout/pack.ts` runs **after** ELK. **The objective is
  one-sided**: it scores only how much *taller* than the pane the box is, so a graph already wide
  enough comes back untouched — a two-sided score folded a perfectly good chain into one column.
  Two rules keep it readable: a card joins a column at its **bottom**, so it may share one with a
  predecessor and never with a successor; and the within-column order is **ELK's**, never
  recomputed. Columns are read off `x` with a **tolerance** of half the layer gap. Gated by
  `packApplies` (homed in `options.ts` beside `aspectRatioApplies`), which asks for `layered` **and
  `RIGHT`**; two further gates stand it down as *correctness* — more than one component while
  `packComponents` is on, and `PACK_MAX_NODES`. **The target is the pane**, clamped, not a fixed
  ratio. **What it costs is ELK's edge routes**, and that signal must be a returned field (`moved`)
  rather than map identity, which is how it shipped broken for a round.
- **`defaultSize` sizes React Flow's _wrapper_, and only a viewer's card fills one**
  (`category: 'visualisation'`). Elsewhere it leaves the state bar hanging below the card. A
  node that only wants to be wider sets `NodeDefinition.cardWidth`.
- **Copy is bound to the clipboard *events*, and a paste that is not a graph must fall through.**
  ⌘C/⌘X/⌘V ride `copy`/`cut`/`paste`, not keydown, because `clipboardData` is readable inside the
  browser's own gesture. `readFragment` therefore runs *before* `preventDefault` — most of what is
  on a clipboard is prose, and swallowing it is invisible from inside the app. A fragment is a
  graph file plus a marker, so a `.coda.json` pastes too; `duplicateSelection` is the same pair
  without the clipboard. A live text selection wins; a paste lands at a point the canvas supplies
  and **steps** on repeat. **Copy is live under the lock**; cut and paste are not.
- **An output socket previews what is on it, and the hover is silent where nothing has run.** A
  port's value exists only once its node has, and hovering may neither fetch nor run (invariant 6),
  so a port with nothing cached keeps its `title` — an inferred-schema fallback was refused, one
  gesture promising two different things being the half somebody acts on. Nothing subscribes per
  socket either: `getState()` per hover, the *panel* subscribes. **The target is the port row's
  side, not the disc.** Three dismissals: leaving, a **press**, and the socket **moving**, which
  fires no event and so is a per-frame rect watch. All of it is **`useHoverPanel`**, shared with
  `NeuronThumbnail`; it opens **right** where the thumbnail opens left, one rule (open into the
  empty half) and therefore one function. Content is **`describeValue`'s own line as the headline,
  never a second spelling**, and no fact may restate it. **The panel is pivoted** — columns down
  it, one row across — with **one value column, fixed**; a matrix keeps four and is not turned. The
  fit is in the builder because the panel counts what it drops.
- **A hint is docked to a card and dismissing it is not an edit.** `NodeHint` is a field on
  `GraphNode`, not a document-level list, so duplicate, copy/paste, `subgraphOf` and delete carry
  it free. It draws as a **sibling of `.coda-node`** (which clips), so `bottom: 100%` / `top: 100%`
  dock it with no measurement and no `ViewportPortal`. **Dismissal is `localStorage`, keyed on the
  hint's text** — in the document it would be an undo step, a dirty file, and a share link arriving
  pre-dismissed for the person being shown the workflow. Cost: reworded copy comes back for
  everybody, hence **Show Hints** and **Show Hints Again**. *Writing* one is an edit, live under
  the lock like a rename. See also [docs/wizard.md](docs/wizard.md).
- **A group frame is not a React Flow node — and a *folded* one is, the same argument reaching the
  opposite answer.** Expanded: `ViewportPortal` at `z-index: -1`, `pointer-events: stroke` on the
  rect alone, `nopan` because panning is d3-zoom's *native* listener; membership is node ids and the
  box is derived, since `parentId` would re-base positions five subsystems read absolutely. Folded,
  it is a box wires arrive at — which is what a node is — minted per render, so `elkGraph.ts` never
  learns this feature by name. `collapsedView` is **one derivation with two readers**, the canvas
  and the ELK pass, or an arrangement gets made against invisible members. Exposed params are a
  **reference, never a copy**. Four silent failures, all browser-only: all-false
  `draggable`/`selectable`/`deletable` make React Flow **withhold the pointer**; the
  multi-selection rectangle sits **over** the cards it surrounds and takes their events, and it
  **includes hidden nodes**; `GroupPeek`'s cards carry the same `data-id`s, so measurement must
  scope to `.canvas-area`; and its panel must stop **bare** keys. `useAnyNodeState` /
  `useNodeStateCount` return **primitives** (invariant 7).
- **Two wires between the same pair of nodes are not a cycle.** `topoSort` derives indegree
  from the same index that decrements it, so the two cannot disagree again.

### Ports, params and node semantics — [docs/nodes.md](docs/nodes.md) and its family files

- **A port typed `T.any()` is usually not `any`.** `CodaType` has no union, so a socket meaning
  *skeletons, meshes or points* says `any` and its node refuses the rest in `validate` — which was
  free until the palette, the socket dimming, the fill, the tooltip, the inspector chip, the
  browser signature and the node guide all started reading the declaration. `PortDef.kinds` takes
  **the array that predicate already reads**. Three rules: the *predicates* keep `any` (an
  unresolved socket is not a refusal) and the *declarations* may not, a set containing it
  cancelling itself (`registerNode` throws); kinds are listed **as they arrive**, before
  `isAssignable`'s widening; and **it refuses**, because once a socket *draws* as Geometries a ring
  you can drop on a `Dataset` port is a promise the picture makes and the behaviour breaks.
  Filtering alone was not enough, so `socketTier` orders — kind, widening, named union, bare `any`,
  **required before optional** — and **declaration order stays inside the node**. **`Geometries` is
  a label, not a `CodaType` kind**: a real union would have to admit points and refuse them at
  `validate`, on top of new cases in `isAssignable`, inference and every key that hashes a type.
  The family is asked of the set's **members**, never of its label, and `any` counts as
  *unresolved* in the fill. **`resolvedSocket` is that rule once**, for the name, the drawing, the
  wire check and the drag — `outputTypesFor` seeds a port's inferred type from its own declaration,
  so `resolved ?? declared` keeps the wrong one. It deliberately does **not** reach `inferGraph`'s
  own input check, which stays `isAssignable`. **Absence means unaudited**, so a port that really
  is `any` says `anyKind: true` and a registry sweep refuses anything saying neither. See also
  [docs/canvas.md](docs/canvas.md).
- **Optional input ports normally compose, and an exclusive set does not.** Every automatic wiring
  pass fills each port with a compatible source, which is right for Connectivity's `neurons` and
  `labels` and wrong for three ports that are three ways of writing one input down.
  `PortDef.exclusiveGroup` is the declaration, read by the demo builder and rendered in the
  assistant catalogue — a *declaration* and not a canvas constraint, since a second wire is where
  `validate` can say which port to disconnect and why.
- **`Find Neurons` asking nothing answers nothing, and that decision is at the node rather than at
  the seam.** No rows and no region means no neurons — not the dataset, which is what it used to
  mean and what put an unbounded `MATCH (n:Neuron)` on a freshly-dropped card. One layer down an
  empty `FindNeuronsRequest.rows` still means *no narrowing*, because `neuronIndex` and Explore's
  whole-table fetch reach the same method. So `asksNothing` owns it and **four surfaces read it** —
  `evaluate`, the card's foot line, and both emitters. **`In ROI` counts and `Limit` does not**: a
  question that merely cannot be a *column* still narrows, where a cap is no statement about
  *which* neurons. It is **not a guard rail**: nothing is refused and there is nothing to raise.
  The empty table carries the **dataset's own** neuron schema, or every column picker downstream
  empties on Run and reads as a broken dataset. The *order* of a deletion and a rename is
  load-bearing: delete the params first and an old file becomes a silent whole-connectome query.
- **A dataset-level filter is not a filter row, the row wins, and the filters OR.** The population
  checkboxes on a neuPrint dataset node are **OR-ed** — a second ticked box lets *more* rows
  through. `typed` matches column names **ending** in `type`. `findNeuronsCypher` drops the
  `traced` disjunct when a filter row names `status`, and all four emitter spellings repeat that.
  Defaults are per **family**. Which queries they reach is `neuronSetRequest`, kept separate from
  `datasetRequest`. And a schema that has not arrived is not a schema without these columns —
  compare `discoveredNeuronSchema` by **identity** before greying a box.
  See [docs/datasets.md](docs/datasets.md).
- **A split is one pass, because two filters with opposite conditions are not a partition.** The
  negation of several ANDed rows is not one condition, so a hand-built alternative drops rows from
  **both** arms — two plausible counts and nothing to say a population went missing. The question
  is asked of the attributes and answered in **items**: bounds **recomputed** (a half claiming the
  whole box frames a viewer on empty space), `units`/`space`/`provenance`/`detail` **carried**.
  **No rows sends everything to `Rest`** — the "AND over no clauses is true" reading makes a
  half-built card indistinguishable from a finished one keeping every neuron. Sentence *and*
  predicate are one declaration each, since **four surfaces read each**. The selection is
  `partitionElements` in `iterables.ts`, so the identity fast path sits where the whole family can
  see it.
- **A collection's attribute table is not the table that named its neurons, and `Carry fields` is
  the bridge.** Each source builds a geometry value's attributes from `SourceSchemas.morphology`,
  so a connectome publishing 48 properties hands `Split Neurons` seven fields. Five rules. **The
  join is `core.join`'s, both halves**, so duplicate keys annotate rather than multiply and an
  unmentioned id keeps its geometry. **A carried column wins its name *and keeps the old one's
  slot*** — `foldNodeColumns`' pair of rules, read by both halves so they cannot drift; the name is
  dropped from the left before the join rather than suffixed after, and an overridden column
  **stays in its slot**, `schema.columns` order being what the table viewer, CSV export and GraphML
  key ids all read. **Empty hands the value back by identity.** **Neither key is ever carried**, and
  `carryable` is **exported** so the emitters cannot write their own weaker filter.
  `neuron.attachAttributes` is the general form and **shares this join rather than copying it**;
  there **empty means every column**, `core.select`'s rule and the deliberate opposite.
  **`onPartial` carries too**, or a scene coloured by a carried column draws nothing until the last
  body lands. And **no bespoke error for a vanished column**: `validateColumnParams` already
  reports it at edit time.
- **A synapse carries no region, and the node that fixes that is a ray per point.** `Points in
  Volumes` takes points on one socket and the same `Volumes` wire the 3D View takes on the other.
  **Two ports *and* a column, because one wire carries many volumes**: a bare pair of ports throws
  away *which*, a bare column makes "keep the ones inside" a second card. **Overlap is counted, not
  assumed away** — the published region list nests and neuron meshes interdigitate, so every box
  candidate is tested, first in item order wins, and the count is said. The minted column is folded
  by `foldColumns`, whose guard asks about the **incumbent** rather than the name. And the node
  rule that outlives the ray: **`evaluate` is on the main thread, so a loop that never awaits
  cannot be cancelled by the click it is checking for** — see `sliced`, below.
- **A long loop in `evaluate` is `core/slice.ts`' `sliced`, and what is shared is the loop, not the
  yield.** Lifting `SLICE_MS`/`yieldToBrowser` and leaving every caller to write its own loop is
  exactly what had been re-derived three ways, one of which never yielded at all. Its clock stride
  **adapts, starting at one**: a fixed stride assumes a body is microseconds, which is true of a
  ray and false of a neuron pair — at 64 bodies between clock reads a Cancel went unseen for
  twenty-five seconds and a walk of fewer than 64 items never read the clock at all. Tested in
  `core/slice.test.ts` rather than in whichever node happens to call it.
- **A distance between two neurons is a distance between two *reconstructions*, and weighting by
  the material is what takes the reconstruction back out.** A skeleton is its nodes and a mesh its
  vertices, so the obvious implementation measures how finely something was traced mixed in with
  how far away the other one is, and the two are not separable afterwards. Every sample carries
  **half the length of each edge at a node, a third of the area of each triangle at a vertex**,
  which makes `mean`/`median` a mean over the cable or surface and `centroid` a centre of mass;
  `min`/`max` ignore the weights, not being averages. The **target side is never sampled at all** —
  a distance is to the nearest point *on* a mesh. Statistics are over **nearest-point** distances
  and never over all pairs, an all-pairs mean being dominated by each neuron's own size. Three
  refusals: non-nanometre geometry, two template spaces, and `within` across **mixed kinds** with
  both directions — `mixedQuantityRefusal` takes **kinds rather than values** so four surfaces
  render one function. The index is a k-d tree and deliberately **not** `topologyOps`' grid, whose
  ring search stops short for two neurons that do not touch and reports *nothing found*. Six rules
  the doc measures: **pruning is on each node's box, not its split plane**; **a closest approach is
  not `n` nearest-neighbour queries** but a property of the two *sets*, so `closestPair` walks both
  trees at once — and **whether a pair can descend is `closestPairApplies`, one predicate**, three
  places having decided it independently and disagreed; a `within` question is a yes or a no, so
  `anyPairWithin` rather than a refined minimum, and it **rejects on the two boxes** before it
  reaches for a tree; an all-by-all is **symmetric by construction** (`symmetricCells`,
  `pairsWalked`), and a missing mirror is invisible in the values, so the test counts index reads;
  `DistanceWalk` carries the two **kinds** rather than a `Quantity` derived from one; and **a
  `Samples` counts itself** (`sampleCount`), three readers having walked `positions.length / 3`.
  **What a tree costs to hold is the half no search rate answers** — V8 gives one context to every
  closure in a scope, so a build's growable arrays stay reachable from the tree unless passed in as
  a `Build`. **The cost model is two models** and `SEARCHES_PER_SECOND` is **two rates**, a rate
  being a rate at a size; index build time is deliberately out of the estimate. `MESH_WARN_SECONDS`
  is stated in **seconds**, not a count. Two absences are decisions: no soma, and no point cloud
  (`DISTANCE_KINDS` is a fifth kind list). Cancel reaches this node through `sliced` and nowhere
  else, so every long stretch — the index build, the pair walk, the centroids — is inside one.
  See also [docs/limits.md](docs/limits.md).
- **A synapse cloud folded into an edge list has to say which end was presynaptic, and `polarity`
  says two opposite things.** It is the *drawn end* on a `Synapses Between` cloud — constant, set
  by `Location` — and the queried neuron's own *role* on a `Synapses` one, so counting the second
  unflipped merges a neuron's inputs and outputs into an edge list with half its arrows reversed:
  right shape, right weights, undetectable. Hence `Orientation` is a control, and a cell reading
  neither `pre` nor `post` is counted and **not** flipped, since flipping on "not pre" turns every
  null into a reversed edge. A weight is a **row count, never a sum** — the point `weight` on one
  backend is a cleft score and on another a predictor score — so there is no value-column picker.
  `Split by` takes extra columns, placed **after `weight`** so a per-region edge list reads the
  same from either node. The one line `validate` adds is the one the framework cannot: rule 3 puts
  **both** pickers on `neuronId` for a partnerless cloud, and two pickers each resolving perfectly
  well onto one column describe no edge at all — `edgePlanRefusal` is that sentence once, for
  `validate`, `evaluate` and both emitters.
- **A synapse point cloud has to say what one row counts, and "min weight" was a confidence
  threshold.** Two bugs that hid each other: a 0..1 predictor score compared against an int floored
  at 1, so the *default* returned no presynaptic site at all; and one `SynapseSet` per partner, so
  the bare walk returns a T-bar once per partner it drives. It is `Min confidence` now, defaulting
  to **0**, with **no `max` because there is no shared scale**. **Renaming the id is what carries
  stored graphs across.** `Rows` is `skeletonParams.ts`' shape — `Automatic` plus the units the
  source declares, a pinned unit it lacks an **error, never a substitution**. Three departures: a
  unit is a property of the **transport**, so the list is static and `validate` complains with no
  peek; **`SynapseRequest.unit` is required and resolved once, at the node**; and a **lone unit is
  not listed**, which is the trap, since a graph pinned to a single-unit source's own unit then
  falls into the "chosen but unlisted" branch. There is deliberately **no third reader**: a
  `PointsValue` carries no unit, so nothing says which one answered after a run.
- **A synaptic partner is usually not a neuron, and a node emitting an edge list has to say which
  it meant.** `Include fragments` is asked as a **`findNeurons` lookup per hop**, not as a clause
  compiled into five backends, so "published" means what `Find Neurons` means on the same card;
  **seeds are exempt**; and it bounds the **frontier** as well as the rows. `absentMeans: 'all'`.
  Under full metadata a `Neuron Set` is a **left join**, a lookup keyed by an endpoint list coming
  back shorter than the list.
- **A normalised weight is meaningless without its denominator, and there are two of them.** The
  same fraction means two different things over every partner and over partners labelled `:Neuron`.
  The outgoing denominator is **`downstream`, never `pre`**; the totals query matches **`:Segment`**
  on the queried end, so a fragment gets a denominator rather than silence; and a missing or zero
  denominator is **null and counted**, never zero. `minWeight` applies to the restricted connection
  **before** any region split, so turning the split on cannot change which partners are found. An
  attached edge set **removes** both capabilities where it *adds* `paths`.
- **A connection carries more than its weight, and a split has to read each region's own share.**
  `DatasetInfo.edgeProperties` is one list read by three controls, **sampled** because the exact
  schema walk takes minutes. Under the region options a property comes out of `roiInfo` region by
  region — absent is 0 only where that connection's breakdown names the property somewhere, and
  null where it never does, because a whole-connection value repeated per region is summed again
  downstream. `perRegion` is a sample: it labels the picker and the query does not trust it.
- **A path's denominator belongs to a population, and the floor that uses it has to prune while the
  search is still running.** A type-collapsed edge's weight is every LC4→PLP1 synapse summed, so
  its denominator is everything *every* PLP1 neuron receives — hence `fetchGroupTotals`, a second
  method rather than a widened `fetchSynapseTotals`, and a second predicate `canTotalGroups`. Its
  type arm matches **`:Neuron`** where the per-neuron one matches `:Segment`: a denominator counts
  the population its numerator came from. **Per hop, not once at the end** — that is the whole of
  what `Min fraction` buys. **`Rank by` is a control because the two weakest links are different
  steps**, so the bound, the neighbour order and the shortlist read the metric through **one**
  function, or a search bounded by one number and ranked by another prunes away its own answer.
  **An unmeasured connection is never dropped and never scored.** The Paths table carries
  `bottleneckNorm` with **no denominator column**, inverting `weightTotal`'s rule on purpose.
- **The drive an Influence walk propagated is already in memory, so its `Transfers` port costs no
  fetch — and it replaced a `Network` port that drew well and read wrongly.** That port emitted the
  induced subgraph of the top scorers, which invites tracing a route and multiplying; most of a
  neuron's score arrives along paths that leave the top set and come back, so the tracing was wrong
  with nothing on the picture to say so. Its arrows also carried raw **synapse counts** while its
  colour carried influence, and the top scorers are mutually connected — that being *why* they
  score — so the layering filled with `back` edges whatever `layer` did. A flow has none of that:
  every band is drive that crossed, so a column's total is the whole of what reached that depth.
  What `propagate` adds is **keeping** each edge's contribution rather than discarding it, behind
  an option that is off for every other caller. Six rules. The grouping is chosen **inside** the
  walk (per neuron pair a four-hop ball is millions of entries), so `ribbons` is an enum answered
  from the walk's own `types` map rather than a key function — that map is filled *during* the
  walk. An **untyped body joins one bucket**, or a run with fragments in it fills the diagram with
  18-digit ids. A band runs **presynaptic to postsynaptic**, which flips with `Direction` and is
  invisible in the widths when wrong — the probe checks 8,019 of them. **`layer` is a drawing
  position, not the hop count**, which travelling upstream runs *against* the signal. **Nothing
  says where the drive went missing**: an earlier version emitted the fragment and frontier losses
  as rows and it was wrong, those being two of *four* reasons a column narrows (the others a dead
  end below the weight threshold, and the budget running out) — so the shortfall is left to the
  geometry, exact by construction, and the reasons stay on the card where `ctx.warn` gives each its
  own number. And a ribbon **into** a body the walk then drops is still recorded, because the drive
  crossed; what stops is anything past it. `Transfer floor` is a **share** of the starting mass, since
  `Seed weighting` moves the total. Removing the port retired `influenceNetwork`, `flowLayer`,
  `NetworkHalf`, the `adjacency` field and a `networkx` dependency; a saved graph wired to
  `Network` loses that edge, and **deliberately not through `formerIds`** — the port is a different
  kind of thing now, so re-pointing the wire would hand a Table to something expecting a Network.
  See [docs/nodes-connectivity.md](docs/nodes-connectivity.md).
- **A bounded influence score is the published one truncated, not an approximation of it.**
  `r = (I - gW)^-1 s` is a series, so walking *H* hops and adding the terms *is* the published
  score stopped early; every term is non-negative, which makes the answer a strict lower bound and
  turns all three losses into numbers rather than caveats. **Which is why the default gain is 0.5
  and not the package's 0.99** — their own docstring says 0.99 amplifies the leading eigenmode a
  hundredfold, and that eigenmode belongs to the connectome rather than to anybody's seed. **The
  directions are not symmetric and the cheap one is the one people ask for.** **It is not a BFS**:
  a neuron is *fetched* once and propagated from every hop, which is what puts recurrent loops in
  at all. **Meeting in the middle buys fetch count, not depth**, and reports no truncation bound.
- **A per-seed channel is indexed by position, so the node deduplicates before anything reads it.**
  A repeat in the table shifts every channel past the first duplicate: one neuron's influencers
  filed under another's name. A test has to use an **interleaved** repeat, a set stacked onto
  itself being already aligned in its first *n* entries.
- **A reduce over a matrix names the axis that *survives*, and its diagonal rule is not
  `skip_self`.** `axis: 'rows'` means each row across its columns, and the type is shared with
  `matrixShape.ts` so the two cannot drift — but the user's phrasing names the axis that
  *disappears*, so both readings are in the option labels and the wrong one is a silently
  transposed answer. **Absence is `Group By`'s rule** (nulls skipped, null for a line with none,
  **0** for `sum` as the identity, `sd` null below two) and both emitters replace infinities first,
  pandas differing there. The spread is **Welford's**: the closed form answers 0 at 1e8, which is
  the worse failure because it claims the line is constant. **`Exclude diagonal` applies only where
  the two label lists are equal**, ignored with a warning elsewhere — the deliberate opposite of
  `nblastMatches`' positional `skip_self`, since any matrix arrives here. The key column is
  **`LABEL_COLUMN_NAME`**, never `neuronId`. **Two params in the key change no number**, so the
  reduction is memoised on the `SHAPED` idiom keyed on what actually varies, with warnings replayed.
- **An aggregation's null rule is one decision made in three implementations, and they had
  drifted.** `mean`/`min`/`max` answer **null** for a group holding no number, where 0 was a
  manufactured measurement among real ones; `sum` still answers 0, the identity rather than a
  value; `countDistinct` no longer counts an absence. The export half is **not symmetric** —
  pandas skips nulls by default and base R propagates them, and `min`/`max` cannot use `na.rm`
  because over an all-absent group it answers **`Inf`**, which survives `is.na` and plots off the
  axis. The goldens compare emitted *text*, so nothing in the suite could see any of this.
- **`Normalize`'s guards were assumptions, and an empty line is not an unusable one.** `total > 0`
  and a maximum accumulated from `0` are correct for synapse counts and wrong for every signed
  matrix. The distinction that fixes it is between a line of *zeroes*, which is measured and stays
  zero, and a line that **holds values** and still totals zero or less, which has no fraction and
  comes out empty with a count said out loud. `max` takes the largest *magnitude*.
- **The graph metrics are two nodes because `cost` is a property of a node type.** `net.metrics` is
  `cheap` and O(V + E); `net.centrality` is `expensive`. One node holding both would have to be
  `expensive`, and then reading a graph's node count would need a Run. Four rules: **a self-loop
  counts towards degree and towards nothing else**, so every structural measure runs on the
  undirected simple projection (which is also where Coda and networkx part company); metric columns
  are written **over** the ones a network had, never beside; **sampling estimates a mean and
  refuses to estimate a maximum**; and **parallel links are merged, summing weights, before any
  path is counted**. One trap in the wiring: `networkMetrics` is memoised and the card calls it
  too, so a warning raised *inside* it goes to whichever caller arrived first — the cost and the
  drop count ride on the result and `evaluate` warns from them.
- **An embedding is a k-NN graph laid out, and the three ports are three ways of writing one down.**
  UMAP is **JavaScript** rather than an eighth Pyodide capability because the pinned lock has none
  of numba, llvmlite, pynndescent or umap-learn. What it costs is a claim nothing here can make:
  two UMAP implementations do not agree cell for cell and neither do two seeds of one, so **`Seed`
  is what makes invariant 4 hold without a nonce**. Two library conventions fail silently and are
  checkable from nowhere inside: **row `i` names itself first at distance 0**, and **every row is
  exactly `k` long**, padded with `-1` — a padded *distance* is the row's own furthest, never
  infinity. Output is keyed `label`, so `Embedding ⋈ Cut Tree` needs no configuration.
  See [docs/python-pyodide.md](docs/python-pyodide.md).
- **The Heatmap's Order tab is data and its Colour tab is not, and the split is the node.** The
  sort reorders the matrix the node *outputs*, so a Table beside the heatmap, the CSV and the
  notebook show what the card shows; those params are in the key. Palette and scale are
  presentational and never re-fold the cells. **The other axis follows by the *arrival* label,
  never by index and never by the drawn one** — the Labels tab makes one name stand for many
  lines, and a clustering interleaves them, so matching on what the card shows returns a block
  per name with the diagonal gone and every cell plausible.
  **The clustering is seaborn's clustermap, not Linkage's** — rows as vectors, distances between
  vectors — where Linkage reads the matrix *as* the distances, and each is wrong for the other's
  input; it is a Pyodide call inside a **`cheap`** node, on purpose. A constant vector goes to
  **distance 1**, where scipy's NaN would refuse the whole matrix.
- **The Heatmap's row and column filters are one term each, and a pattern is opted into with `/`.**
  A plain term is a case-insensitive substring, a leading `/` makes it a regex, `!` or `-` negates.
  `bareRegex` is **imported** from `neuronSearch.ts`. The opt-in is not taste: `SMP001(a)` compiled
  as a pattern matches nothing, which is why both exporters emit `regex=False` / `fixed = TRUE` for
  a literal. One term per axis. **An uncompilable pattern leaves that axis whole** where **a filter
  matching nothing is honoured**. Filter runs *before* the sort, and both are one mechanism.
- **A profile's subject is a neuron or a group of them, and the grouped answer is the ungrouped one
  folded.** `Group by` is a **column picker, not a `Show types` boolean** — a boolean has to name
  `type`, which is the one thing that card's own rule forbids. It stays **presentational** because
  a **pin resolves the group to member ids at pin time**. The subject layer partitions the fetched
  table and runs the *same* single-neuron roll-ups per part; reimplementing them over a grouped
  table is how the untyped bucket, the `>= minWeight` boundary and the nested-ROI filter come to
  disagree while still drawing a plausible bar. **Absent is a measured zero**, inverting
  `groupByTable`'s null rule on purpose, which is why `Aggregate.present` rides beside `mean`. `sd`
  is **null below two members**. Above `MAX_AUTO_MEMBERS` a subject is **deferred, not refused**.
  See [docs/widgets.md](docs/widgets.md).

### Viewers — [docs/viewers.md](docs/viewers.md)

- **A heavy-tailed measure is a rank plot, and the half that is not otherwise reachable is the
  share.** Length encodes ratio and a connectome's ratios do not fit in one: linear, the largest
  bar is full and the rest are slivers; on `influenceLog` — already `log(max(x, e^-24)) + 24` — a
  thousandfold difference draws as **1.7x**, a plausible figure saying the measure is flat. So
  dots on a log axis, and underneath the running **share of the total**, which `out.histogram`'s
  `cumulative` cannot be: its curve is over **rows** where this one is over **values**. Two panels
  sharing the rank axis, **never two y-scales**. Four refusals and a warning, all in
  `rankSeries.ts`: a share of a total means nothing over a **signed** column (ranked descending the
  running sum climbs past the total and comes back down — a curve that looks exactly like a Lorenz
  curve and reaches 1.4), so the panel is withheld with a reason **and the ranking above is
  untouched**; an all-zero column has no total; a **flagged** row is plotted, ringed, ranked and
  excluded from **both** halves of the share (seeds carry most of it and the curve says nothing),
  which makes *everything* flagged a refusal of its own that has to be asked before the all-zero
  one or it answers in that one's words about a column full of scores; and what is dropped is
  counted **by reason**, a missing value being a wrong column where a
  non-positive one is a scale the reader chose. `validate` catches the one pairing the resolver
  cannot — a column that is already a logarithm, logged again. Three things only a browser said:
  `plural(n, noun)` already formats the number; `logTicks` spends its budget on **decades** and
  then strides, so a count of three over four decades lands on 0.001/0.1/10 and labels the axis
  once; and on a log rank axis the leading five ranks sit inside the first fifth of the width, so
  labels on one line collide. See [docs/viewers.md](docs/viewers.md).
- **A Sankey's grammar is conservation, so the caption measures it rather than assuming it.** Most
  connectome Sankeys are drawn on synapse counts, which conserve nowhere — a neuron's incoming
  count has nothing to do with its outgoing one. `out.sankey` cannot refuse such a table, so it
  prints how far off the drawing is (`conserves`, or `18% stops`) and turns the mark's claim into
  one a reader can check. **The shortfall belongs to the node, not the column**, which shipped
  wrong: a node is drawn as tall as the larger of what it took and what it sent, so it *already*
  absorbs its own shortfall as unused bar, and a notch at the column's foot counts the same
  quantity twice and invents drive. Two cases it must not fire on — the **last** column, whose
  outflow is zero because it is the end, and **layer 0**, which has no inflow by construction and
  gets a feathered edge. **A node is a (layer, label) pair**, or a label that repeats down the
  diagram merges into one node and the flow acquires cycles. **Folding is safe here** where
  `out.flowChart`'s is not — summing merged bands preserves every column total exactly. The
  within-column sweep is **`barycentre.ts`**, shared with the flow chart. Three browser findings: a
  gutter reserved past the last column is dead space (its labels draw *before* its bar), a muted
  band at 0.38 over `#1a1a19` reads as an uneven background, and bands meeting one node face are
  **stacked fills** and want the surface gap the bar chart already gives its segments.
  See [docs/viewers.md](docs/viewers.md).

- **A 3D renderer is handed between surfaces, not rebuilt — and what is kept is the root, never the
  viewer component.** `PersistentCanvas` replaces React Three Fiber's `<Canvas>`: the root, its
  canvas and the element events bind to are held under `scopedKey(workflowId, nodeId)`, parked off
  screen when a surface unmounts and released after 5 s. Two traps, both silent: a portal owning
  the *whole* viewer moves its React events off the surface's tree, and React Flow's select,
  double-click and context menu are React props on the node wrapper; and a context bridge is a
  component minted per instance, so bridging remounts the scene it exists to keep. Node ids repeat
  across two workflows opened from one file, hence the workflow in the key. **The Neuroglancer
  card's iframe is kept the same way, and only where `Element.moveBefore` exists** — any other move
  reloads an iframe onto whatever `src` it last had while its bookkeeping still claims the scene.
- **A three.js vertex colour is linear light, so the one hex parse returns it.** three reads a
  `color` attribute as already linear and encodes on output, so an sRGB triplet written straight in
  is encoded twice — every skeleton and synapse point drew lighter and greyer than its own legend
  swatch, while meshes were right, which is why nobody saw it. `hexToLinearRgb` linearises at the
  parse, so no caller holds an encoded triplet to write; a **mid grey** is the test case.
- **The fat-line path is four shader patch sites that must agree, and a patch that stops matching
  is silent.** three's `LineMaterial` takes one `linewidth` uniform, so `flexLineMaterial.ts`
  rewrites three's own shaders — vertex *and* fragment for the world-unit mode, or the box and its
  silhouette disagree. It **throws rather than falling back**, because a `ShaderLib` rename compiles
  fine and draws every skeleton at the uniform width. Three numbers are load-bearing: scale against
  the **p95** radius, never the maximum; keep the 1px floor, since a floor cannot be a number of
  nanometres; and three's `rayEnd … * 1e5` is exactly 100 µm in a nanometre scene, past which every
  fragment discards and the arbour vanishes whole in one zoom step.
- **A post-processing pass moves the background out from under the scene, twice.** An
  `EffectComposer` renders into a texture, so the canvas colour needs `scene.background` (not the
  clear colour) and `<Canvas flat>` (tone mapping is per-*image* through a composer). Four more
  seams it owns: `setSize` takes **CSS pixels**; the PNG export renders its own frame and must go
  through the chain; `_overrideVisibility` misses fat lines, which is what `hidesFromGtao` is for;
  and **both** world-unit uniforms are rescaled, a library's world-unit defaults agreeing with each
  other. Strength is one slider where 0 is off. And **a `useMemo` may be reused across a remount
  while an effect cleanup always runs**, so return the pass from the memo rather than writing it
  into a ref. Measure on a real GPU — headless Chrome falls back to SwiftShader.
- **Shape folds where colour cycles, and that asymmetry is the design.** `resolveShape` mirrors
  `resolveColor` except for the tail: six marks, and everything past the sixth becomes a **dash**,
  which shares no silhouette with any of them. Cycling a hue is survivable; a seventh category drawn
  as a second circle is a claim that two categories are the same thing. Sigma draws only discs, so
  `nodeShapeProgram.ts` replaces `@sigma/node-border` outright, and three things there are silent
  when wrong: **sigma blends premultiplied**; the vertex quad inscribes `v_radius` while marks are
  sized for equal *area*, so `MARK_EXTENT` buys headroom **per shape**; and the shader **flips
  `p.y`**. The proportions live in `markGeometry.ts` and the **GLSL is generated from them**. The
  program module is **dynamically imported**, `sigma/rendering` touching WebGL globals at module
  scope.
- **A flow chart and the Network Viewer draw the same material, and the choice between them is
  size — which is why the layout is Sugiyama by hand rather than ELK.** `out.flowChart` is SVG,
  boxes sized to their own text, arrows routed round what is in the way, a number on each; the
  Network Viewer is WebGL discs with the label beside them, right at 36k nodes and wrong at twelve.
  `FLOW_NODES_WARN` (120) says *crowded*, `MAX_BOXES_DRAWN` (600) declines and names the other
  node. Four reasons it is not ELK, each about this drawing: **the layering is already decided**
  (`elk.partitioning` *ignores* one handed back, which `docs/canvas.md` records from a sweep, so
  two layerers is one being silently overruled); **back edges must keep their direction**, where
  ELK reverses them internally and returns the reversed route, leaving feedback indistinguishable
  from feed-forward; **box sizes are text**, so the layout runs in the viewer and a worker round
  trip buys nothing — and there is therefore **no `Layout` socket**, `Paths` computing its
  positions against a 120x36 placeholder that overlaps every wider box; and synchronous means no
  settle effect and no frame of the wrong picture. The algorithm is not re-derived: **the dummy
  nodes are the load-bearing part**, without which a skip-layer arrow runs through the boxes
  between its ends, and with which the ordering step keeps a corridor clear because a corridor *is*
  a node to it. **A layer is not a hop**, which is the whole of the layering control: longest path
  is right for `Paths`, whose `hop` column it reproduces, and wrong for any network assembled from
  a ball rather than from routes, where longest path puts a one-hop neuron five columns out because
  something reaches it the long way — so the picker is `optional`, empty means longest path, the
  caption says which ran, and it is deliberately **not** "automatic, preferring a column
  called `hop`", which is `resolveColumn` rule 3's recorded substitution wearing a name. Four edge
  kinds told apart **by shape, never colour** (colour is spent on the data): `back` dashed, since
  drawn as forward it is an arrow through the boxes between its ends and reads as a data error;
  `within` bulged off the flow axis; `self` a loop. The fold is presentational and says what that
  costs — a folded network is not available downstream, because the alternative is that nudging a
  figure's density re-runs a connectome query. **Both helpers agreed with the canvas on the first
  run and every bug was in the dozen lines that draw**, which is why `pnpm probe:flowchart`
  executes the emitted *cell* out of each golden: igraph's `extd_graph` carries **only `orig` and
  `arrow.mode`** so `E(.g)$weight` was `NULL`, a split edge is three edges there so a label printed
  three times, `sugi$layout` has a row per *real* vertex so plotting the extended graph with it
  throws, and Sugiyama's layer axis runs **downwards** so exchanging the axes alone drew the
  circuit right to left — plausible, and backwards. The gift from the same measurement:
  `arrow.mode` is already 0 on every piece but the last, so the emitter must not touch it.
  **`pnpm probe:flowchart-draw` covers what jsdom cannot reach** — boxes hold their
  text (the font one: a canvas `measureText` sizes the box and `.chart text` draws it, so the
  measurer reads `--font-ui` rather than spelling a family that agrees only where `system-ui`
  resolves), nothing overlaps, no arrow crosses a box, it fits, a click selects — **and the two
  real defects came from looking at the screenshot**, both of which make every one of those
  properties *more* comfortably true: the fit would not magnify (`Math.min(1, …)` drew 18 boxes
  340px wide in a 1250px panel; `MAX_FIT` is 2), and arrows ended at their layer *band's* edge
  rather than the box's face, leaving the head floating ~40px short wherever one layer holds
  boxes of different widths — invisible in every uniform-size fixture.
  See [docs/viewers.md](docs/viewers.md) and [docs/limits.md](docs/limits.md).
- **A force simulation cannot lay out a graph that is mostly not connected, and the force law is
  not what fixes it.** Two components share no edge, so nothing in a simulation decides where one
  sits relative to the other; ForceAtlas2 answers by accident and gets **worse the longer it runs**.
  What wins is refusing the question: lay each component out alone and pack the boxes. It is now
  the **default**, which is what forced `prefuseRun` — the per-component yield cannot interrupt a
  *single* component and an ordinary connectome is one, so the simulation is resumable and sliced
  against the clock. The annealing state rides on the run because it compounds; restarting it per
  slice re-heats the simulation and still draws something plausible. It departs from prefuse only
  where prefuse relies on `Math.random()` or on float precision running out. Two traps: a separation
  test passes **without the feature** below about forty components, and `componentLabels` must keep
  agreeing with `networkOps.connectedComponents`.
- **Two network colour modes cannot be columns, and that is why they are modes.** A node's
  connected component is derived from the link set; a link coloured by its upstream node resolves
  against the *node* table. `networkColor.ts` hands both to `resolveColor` as something it can
  already answer. Components are numbered largest-first so that ordering agrees with
  `resolveColor`'s frequency ranking by construction, and they are undirected. An
  endpoint-coloured link reads the *resolved* node channel and draws **no legend**.
- **Node dragging is five silent failures, not a mousemove handler.** Sigma ships none of it.
  `autoRescale` renormalises against the node extent on every refresh, so a drag must
  `setCustomBBox` first or the graph shrinks away under the cursor — and ⤢ must clear it again, in
  a `refresh`. `preventSigmaDefault` is what stops the camera panning, and it is *also* why sigma
  still emits a click at the end, so the click handlers need a tolerance of our own. The drag ends
  on the captor's `mouseup`, not `upNode`. A grab on a selected node moves the whole selection;
  positions are a delta from the grab, never a snap. Arithmetic in `networkDrag.ts`, headless.
  Session-scoped through `layoutMemo`, never the document.
- **The network's right-click menu borrows three things rather than writing them.** The rows and
  dismissal are `NodeContextMenu`'s; the "acts on the selection if you clicked into it" rule is
  `seedsFor`, shared with the drag; and the walk is `net.filter`'s `expandSelection`. What is added
  is **node order** on the result, because it lands in an `ids` param that reaches a provenance key.
  Sigma routes a right-click to exactly one of node/edge/stage, so the browser's menu is cancelled
  on the *container*, and the menu is on `useOverlayEscape`'s stack above the overlay.
- **The heatmap's circles encode the value a second time, and read the *bucket* to do it.** Area
  not radius (`resolveSize`'s rule), and the bucket rather than the value — a bucket is already
  the value's position on the ramp, so the log, the manual ends and the clamping reach the radius
  for free and `colorDomain` stays the one mapping. Size is distance from `neutral`, the hue
  keeping the sign; `RAMP_STEPS` being **even** put the diverging centre between two buckets, so
  the neutral point is continuous or the two arms draw different circles. **A cell at the neutral
  end draws nothing**, which is the point on a sparse matrix and costs telling a recorded zero
  from an unmeasured one. `circlesFit` is a **size test on the spec** with the param `&&`-ed in at
  render (`Show values`' rule), too dense falls back to squares, and the card **says so even under
  `compact`** — it is a note about a *control*, not about the picture. Neither exporter draws
  circles and both carry `shapeNote`, seaborn's `heatmap` being a tile renderer.
- **The heatmap's colour ends are manual-or-automatic and its log is on the colour alone.** One
  `colorDomain` decides a value's ramp position, so `normalize`, the per-cell `bucketScale`, the hit
  test and the SVG export cannot disagree. A limit is a **`string` param** because a `number` has no
  unset state and `0` is an ordinary limit; an inverted or unreadable pair is **dropped whole**.
  **Diverging offers one end**, or the middle stops meaning zero. The log is
  `log1p(v − lo) / log1p(span)` — the shift by `lo` is what makes it total on negative data, and it
  equals the exporters' `log10(1 + v)` because a ratio of logs is base-independent. It stays
  **monotonic**. seaborn's **`annot` takes a frame of its own** and ggplot gets a `fill_` column
  beside the untouched `value`: that is how the numbers stay raw under a transformed fill.
- **`by value` on the 3D, Scatter and Network viewers is the Heatmap's colour domain, not a copy.**
  `colorParams({ valueScale })` adds a ramp, both ends, a centre and a log, and `ui/encoding.ts`
  holds them for both. Three rules: an automatic bottom is the **data's minimum** (the Heatmap's is
  zero), so a node on the defaults draws what it always drew; a centred ramp is **symmetric** about
  its centre, so it has no `Min` and no log; and "numeric columns only" is `ColorBy`'s `dtypes` as a
  function of the mode, `visibleIf` not being able to see a schema.
- **A heatmap's rectangle selection is a set of positions, and "store the meaning, not the position"
  is the rule that had to bend.** It was **labels** first — `chartSelection.ts`' standing rule — and
  was reported as a bug within the hour, because **a heatmap's names are not identities**: the
  Labels tab exists to replace ids with cell types, one-to-many by design, so a box round one cell
  of a fourteen-row block selected all fourteen. A re-point is visible on the card the instant it
  happens, where a name quietly widening a selection is visible nowhere. The general half: that rule
  assumes the mark *has* a unique meaning, and a viewer whose job is renaming is where that stops
  holding. **One param, both axes** (two params are two commits, and an undo would take back the
  columns and leave the rows), while the two *outputs* stay separate. Adding is a **union, never a
  toggle**. The drawing is **bands, outlined never tinted**, colour being the data — and **no
  colour at all, because a ramp leaves none**: a white dashed core over a black casing, every
  single hue tried measuring between 1.00 and 1.96 against some cell of some palette (yellow
  among them, blind exactly on viridis/inferno/magma) where the pair measures 4.59. The **dash**
  is a separate finding and not a contrast question: the band's other neighbour is the inter-cell
  separator, which is the *surface* showing through, so on each theme one of the two tones is
  already the grid. **`label` and
  `relabel` are two columns**, and `evaluate` carries the arrival names through the filter and the
  sort on the identical index lists. **A selection in the provenance key means the reshaping has to
  be memoised**, or a drag re-crosses the Pyodide bridge once per gesture. **Three chords and a
  click**: `isAdditive` asks whether a press is a selection *at all*, so the adding chord has to be
  something neither Shift nor ⌘ alone already means — Shift+⌘, beside the Alt that `ScatterViewer`
  uses for the same act and that is kept rather than retired. A press with **no drag in it** is one
  cell through **`cellAt`, never a zero-width `linesInRect`** — `pointToMatrix` has no bounds of
  its own, so a gutter press comes back *clamped* onto line 0 and a press on a line boundary spans
  nothing. **The `!compact` gate was never about cards**: React Flow's pane claims a shift-press
  *anywhere* inside it and stops propagation in the capture phase, so `nokey` on the container is
  the whole of what selecting on a card needed — and the click still has to be stopped separately,
  `nodrag` filtering only the drag while a node's selection rides on the `click`.
- **The heatmap's zoom is a window in matrix units, and the window is what gets folded.** Not a
  scaled canvas: scaling keeps the fitted fold's blocks, enlarges them, and scales the labels, which
  is the one thing they must not do. So zooming in folds *fewer* cells and past 1:1 real cells
  appear with their own labels, re-thinned for the pitch. Per-axis `AxisMap`s carry a grid origin
  *before* the plot's edge, so both renderers clip to three zones. The colour domain is memoised
  apart from the window — a pan must not rescan, a zoom must not recolour — and matrix units are why
  a resize keeps the zoom. Two browser-only findings: **the canvas raster is not in any
  `performance.measure`**, so the cells are an `ImageData` blitted with smoothing off and the paths
  are the SVG export's alone; and **an interior line's visible extent equals its pitch only up to
  rounding**, so the sliver test carries a tolerance.
- **The dendrogram's zoom is a window along the *leaf* axis only, and that asymmetry is the
  finding.** A dendrogram's leaf axis is a list and its distance axis is the *measurement*, so
  zooming about a pointer part way up it moves the window off the leaves — readable names beside two
  brackets and an acre of empty card. Holding the distance axis whole also makes two zoom states
  comparable and keeps the root's crossbar on screen; the case the other version served wants a log
  scale, not a zoom. Its price is that **a drag along the distance axis does nothing**, by
  construction. Three rules exist because this viewer's purpose is *clicking* branches: **pan runs
  only while zoomed**; **the flag saying a drag happened is a ref, not state**, or `pick`'s identity
  changes and every bracket re-reconciles on each pointer move; and **pointer capture is taken at
  the slop, not at the press**, because capturing from `pointerdown` sends the `click` to the
  capturing element. All three are **`usePanGesture`**'s, shared with the ROI viewer; the wheel is
  **`useWheelZoom`**, shared with the heatmap. Everything the window feeds is **memoised**.
- **A dendrogram leaf's *name* is a drawing and its *label* is the identity, and the Annotations
  port only ever touches the first.** **`evaluate` never reads it** and both pickers are
  `presentational`, which is the whole design: the leaf's label is what `cluster.selectedToNeurons`
  matches against a neuron table, so a tree renamed by cell type turns one clade into every neuron
  of those types — plausible, wrong, and nothing raises it. What is bought is that trying `type`,
  then `instance`, then `hemilineage` changes no provenance key and re-runs no `expensive` Linkage.
  Both pickers are **`optional`**, a required one being substituted by rule 3. The join is
  `labelsByNeuron`, so its rules come with it. An **unnamed leaf keeps its own label**, inverting
  `core.relabel`'s `Unmatched` default; the caption counts them. **The Heatmap has the same port and
  it is the opposite kind of thing** — its axis labels are *data*, matched by the Filter tab and
  sorted by the Order tab, so a presentational rename there would show a name the filter could not
  match. `displayLabels` is shared and each caller decides what the answer is.
- **Restoring `layers` in the embedded neuroglancer is not safe under the pointer, and one bad id
  is not one bad id.** A layer is constructed — subscribing to the hover machinery — a whole loop
  before it is initialised, and neuroglancer never disposes that subscription, so any layer that
  dies in between throws on every mouse movement for the life of the document; the crash surfaces
  on `mouseout` rather than on the edit. Two ways in, both closed: an update is **held until
  `mouseleave`** (replacements too, but never the opening navigation), and every segment id goes
  through **`isSegmentId`**, since a miss deletes the layer rather than the id. That filter is in
  **`buildScene`**, not in the node, because the profile frame is the other caller. Third rule, and
  why none of this reproduces in production: **`proxiedViewer` says a prefix is declared, not that
  anything serves it**, so a static deploy 404s instead of degrading.

### Backends and data — [docs/backends.md](docs/backends.md)

- **An edge list is not a skeleton.** `SkeletonGeometry.parents` is a rooted tree in *visit order*,
  built from an undirected graph that may hold cycles and disconnected components.
  `spanningForest` (`src/data/skeletonTree.ts`) is the one walk; a surviving cycle makes every
  consumer that walks to a root loop forever.
- **A skeleton is not one product, and which route answered is a fact about the *value*.**
  `SkeletonsValue.provenance` rides on the value and the Skeletons node's `Source` is where you
  choose. Four rules: `skeletonSourcesFor`'s **order is the preference `fetchSkeletons` applies**,
  so "Automatic (published skeletons)" cannot name a route the fetch would not take, and
  `capabilitiesFor` is derived from that same list; **a pinned route the dataset lacks is an error,
  never a substitution**, whose vocabulary half is the shared `requireSkeletonRoute`; a service
  that **generates on demand** is asked `exists` before any download, and `automatic` takes it only
  when it covers *every* neuron, a scene mixing a reconstruction with a chunk decomposition being
  one where a number means two things; and neuPrint's published route resolves the **volume**, not
  the mesh directory. See also [docs/nodes-morphology.md](docs/nodes-morphology.md).
- **Two ways a mesh source resolves to somewhere with no meshes in it**, both reported as neurons
  that have none. `@type` is optional on a precomputed volume, so `isVolumeInfo` — not a `switch` —
  is the one predicate. And a graphene fragment **name is an instruction, not a path**:
  `~<layer>/<shard>:<offset>:<length>` means a `Range` read of a shard, while anything else is a
  plain object. `mapWithConcurrency` tolerates a dropped fragment, so either half read wrongly
  draws **a mesh in the right place that is a fraction of the neuron**, under a green node. Hence a
  tolerated partial answer has to be **counted**, and this is the one fan-out *below* the item
  level. Three rules from the reporting: **the tally rides on the value** (`MeshDetail.fragments`),
  since a second Run skips the fetch entirely and a per-run counter then reads zero beside the same
  short meshes; **`unaddressable` is split from `missing`**, only one of them being a retry; and **a
  neuron that failed whole is a second sentence**, or the fix trades "a twentieth of the neuron,
  silently" for "no neuron, silently". The assertion is **live** — a URL is only right if the
  bucket answers it. Downstream: the mesh is **decimated over the fragments** rather than over a
  joined copy, which is byte-identical and therefore asserted rather than argued.
- **A lone neuron does not price a set, and the neuron you measure alone is by selection a big
  one.** A cost warning built from one body told somebody fetching 25 meshes to expect five minutes
  and 350 MB for half a minute and 98 MB. Re-measure over *sets*. It also retired a split invented
  rather than measured, and moved the threshold from a **count to a wait** — `MESH_WARN_SECONDS`,
  with the neuron count derived from it, so the condition and the sentence are one piece of
  arithmetic and a re-measure moves both.
- **One control cannot mean "pick a published level" on one dataset and "recompute the geometry" on
  the next.** `GeometryRequest.triangleBudget` says *a source with one level ignores it*, so a
  backend honoured the Meshes node's `Detail` by clustering vertices instead, which nobody could
  discover without measuring. Two controls now: `Detail` spends a budget among published levels and
  is **drawn dead where there are none** (`undefined` meaning *nobody has looked* rather than *no
  levels*, a control that greys itself out for the first second of a session being one people
  distrust), and `Downsample` is a factor on the **request**. It defaults to **1, full resolution**
  — the bug that looked like a size limit was a *draw* limit — while `0` is automatic, a **triangle
  target** rather than a factor because no factor suits two datasets at once. **Absence is a third
  answer** (`absentMeans: 0`): a graph saved before the control existed was drawn by a build that
  reduced automatically.
- **A draw call has its own limit, and it is not memory.** Firefox caps index values per draw at
  30,000,000 and refuses the draw in silence, so full-resolution meshes drew *nothing* there.
  `drawRanges`/`MAX_INDICES_PER_DRAW` split a mesh across draws, sharing the `position` and
  `normal` attribute *objects* and slicing only the index; normals are computed once on a throwaway
  geometry, or each piece smooths as if the others were absent and a seam runs down the neuron.
  **The diagnosis that this was GPU memory was wrong and shipped into these notes** — the tell was
  the user's own question, *neuroglancer draws dozens of these*, which it does by drawing each
  fragment separately. Chrome enforces no cap, so this reproduces in one browser, on large meshes
  only, as an absence. **Any decimation factor is fitted, not calculated**: the surface law is
  wrong for a thin tree in a big box, so two counting probes give the local slope and one
  correction runs from the *result*.
- **A tolerated failure and a global alarm cannot be the same line.** Reporting every auth refusal
  to the channel that *opens the Connections dialog* meant a user with no access to one of three
  datastacks got a dialog on every Run of a graph that ran fine. A request made speculatively
  carries `quiet` — **every peek included**; the backstop is that the listing reports **once** when
  nothing at all came back, and `refuseAuth` is the single site that decides. A listing longer than
  what works is the ordinary state of a new account, not a bug to design around, and `missing_tos`
  is not a bad token — telling somebody to sign in again is telling them to do the one thing that
  cannot work. Third half, found by fixing the first two: **a tolerated refusal is still the answer
  to a question somebody will ask**, so `DataSource.whyDatasetMissing` reads the listing's kept
  failures, synchronous so `validate` marks the card before a Run, and `undefined` there means
  *nothing is known* rather than *nothing is wrong*.
- **A CAVE sign-in is a popup and a `postMessage`, and every hard part is a silent ending.** The
  auth service is itself the OAuth client, so its callback page posts to `window.opener` with target
  origin `"*"`: nothing to register, no secret to ship, and a static deploy can therefore sign
  somebody in. Four consequences. The login prefix is **read from `/auth_info`** and never assumed.
  The window is opened **blank, before** the lookup that points it, one opened after an `await`
  being blocked. A message is a token only when `source` is the window we opened **and** `origin` is
  the service discovered before opening it — `"*"` cuts both ways. And **the paste field stays**,
  for the exits that hand nothing back. A **first login is not one of them**, so the first-run
  failure to expect is a 403 on a datastack after a sign-in that worked. What is stored is the login
  token plus a **label, not an expiry**. **neuPrint's sign-in (DatasetGateway) is the same window
  machinery, `popupSignIn.ts`, with the opposite registration rule**: DSG posts only to an
  allowlisted origin, compared exactly — `127.0.0.1` is not `localhost:5173`, and registering
  `navis-org.github.io` alone missed the `coda.science` custom domain the site actually runs on — and
  answers any other with `"badorigin"`, which is a refusal of its own rather than a closed window.
- **A geometry is the morphology of exactly the id asked for, at the materialization asked for —
  never an id mapped to another timepoint.** MICrONS' v661 SWC release was a route once, reached by
  walking today's root id through its nucleus to the root it had at 661: every file came back under
  today's id, and it was a different, older segment — median 49% of the current cable across 40
  proofread cells, 23 of them with no axon where the id's own segment has a proofread one. It
  looked like data, not like a bug. Removed; a published product keyed by other ids is usable only
  where its ids *are* the requested ones. And **a skeleton's compartments are the source's**:
  SWC codes where the source labels them, absent otherwise, never `out.topology`'s computed codes;
  minnie65's service sends them as `uint8`, which a float-only reader skipped in silence. See
  [docs/backends.md](docs/backends.md) and [docs/cortex.md](docs/cortex.md).
- **A lookup that failed has not answered "none", and a shared request carries nobody's signal.**
  Three CAVE lookups read a cancel, a 5xx or a `429` as "no level-2 cache", "no service" or "not
  cached" and kept it for the session — so a gallery that cancels as its wall moves drew half its
  cells from the level-2 route, unlabelled, on a datastack whose service held every one. Only a
  404 is a verdict. The skeleton service's `exists` is rate-limited (100/minute), so a caller
  fetching neuron by neuron names the set first (`DataSource.planSkeletons`). See
  [docs/backends.md](docs/backends.md).
- **CAVE's row cap is a per-deployment number, and a reference table has no root id.**
  `CAVE_MAX_ROWS` is one server's limit, so truncation is tested against the server's own `COUNT`,
  never the constant and never with `>=`. A reference table carries `target_id` and no root id:
  reading one means the *join* endpoint, which takes `select_column_map` and only that, and ignores
  `count=true`. Both failures read as facts about the data.
- **A published token is not a credential, and shipping one makes a rotation a new failure mode.**
  Virtual Fly Brain publishes an anonymous token per instance because CATMAID's query endpoints are
  POST-only and a browser satisfies neither of Django's CSRF gates. `publicTokens.ts` is a committed
  snapshot refreshed from their manifest in the background, and three of its rules exist because the
  obvious version fails silently: it **loses to a user's own token**, or a real account's data
  disappears with nothing to say why; a **401 drops it and retries**, since the client stops at the
  first response it gets, and a token the *user* typed is never dropped; and the manifest is fetched
  `cache: 'no-cache'`, being served `immutable` with a one-year max-age.
  See [docs/catmaid_vfb.md](docs/catmaid_vfb.md).
- **A ZapBench trace is priced in *blocks*, not neurons, and the id that finds it is off by one.**
  The released array is uncompressed, which is what makes every byte offset arithmetic and a partial
  chunk read possible at all; `live.test.ts` checks that codec list, a compressor added upstream
  returning noise shaped like a trace rather than failing. **Neurons are on the contiguous axis**,
  so one neuron costs what 512 adjacent ones cost and `Condition` is the only control that reduces
  the bill. A multi-range request would be the obvious win and GCS **refuses it outright**. The seam
  is worse than the fetch: the id is the **1-based segmentation label** and the column is one lower,
  both readings being in range for every id but the two at the ends, so a wrong choice returns the
  *neighbouring cell's* trace — real, plausible, and wrong. The range could not settle it and
  **geometry did**, the offset sweep being what makes a fitted residual mean anything. Two more
  traps: `resolveColumn`'s **rule 3** hands a required picker the first compatible column, so
  `excludeIds`, a `validate` warning and a run-time range refusal are three answers because none
  alone is enough; and the node emits a **matrix and nothing else**, a long form being four times
  the memory and built whether anything read it. See also [docs/nodes-io.md](docs/nodes-io.md).
- **The ZapBench release holds the same numbers twice, transposed, and neither copy wins — so the
  reader costs both per request.** One copy is row-major, the other carries a `transpose` codec that
  makes a *neuron's* timesteps contiguous. The crossover is real and is why both are kept:
  row-major wins on a **narrow window over many neurons**, where the transposed read bridges
  hundreds of unwanted neurons for a few values each. Hence plans are compared in bytes **plus
  requests priced in bytes** (`REQUEST_BYTES_EQUIVALENT`), which is also what decides whether to
  bridge a gap or spend a request. **The pyramid is unusable for a neuron's trace and that is the
  finding**: the downsampling applies to *both* axes, so one level down averages each neuron with
  its neighbours and nothing in the value could tell. Three traps: the permutation is **checked,
  never trusted**, with a fallback to the slower route to the identical answer; `sorting.ts`
  **imports nothing from `traces.ts`**, the cycle being safe only while every read is inside a
  function; and **only one product has a sorted copy**, so the layout is chosen per *product*. The
  cost warning is priced from the **chosen** plan.
- **A ZapBench row at a reduced scale is a bin, and its label is the list of cells it averages.**
  Naming a row by the cells it averages keeps a downstream lookup exact without the second node
  knowing the scale; a scale param there would be a second copy of the first card's decision. Four
  traps: **`s2` is built from `s1`**, so a partial **time** bin is dropped and a partial **row**,
  exact at both levels, is kept; a row's name rests on the permutation *and* on a level still
  averaging the one below, so `verifiedLevel` **refuses** on failure, there being no slower route to
  the same answer; **an integer property looked up as text matches nothing**, so values are spelled
  as numbers wherever the **discovered schema** types the column numeric; and the lookup takes
  `datasetRequest`, never the population.

### The shell — [docs/ui-shell.md](docs/ui-shell.md)

- **A row that does not wrap does not clip — it moves the whole page, and only on a phone.** The
  toolbar's controls came to 973px of min-content width with no `flex-wrap`, so the *document* was
  973 wide; a mobile browser answers that by zooming out to fit, and every reported symptom is that
  one number. It reads as a broken layout. **A desktop browser cannot show it** — at 412px a window
  has a scrollbar and no minimum scale — and neither can jsdom, so the measurement is
  `pnpm probe:mobile` and the property is **the document is never wider than the viewport**. Below
  `NARROW_QUERY` (**width only**, a short desktop window having all the width it needs) the row
  folds into `⋯`. The threshold is **TypeScript, stamped as `data-narrow`**, a stylesheet not being
  able to import a constant; the rule that survives is **a plain media query wherever no React
  branch is paired with it, the attribute only where one is**. Three rules from the fold: a
  control's **`label` is its menu row *and* its accessible name** (two fields is how a control gets
  two names, and `title` is the *tooltip*, a poor thing to hear read aloud); what stays out of the
  descriptor table is decided by the **shape a menu row can take**, never by holding state; and
  chords come from **`shortcutKeys`**, never typed, a hand-built table being exactly where `⌘Z`
  gets advertised to Windows.
- **A submenu opens right, else left, else *under* its row, and the third answer is not a phone
  rule.** A 260px panel beside a 260px one is 520px, so a *flip* is a choice between two impossible
  positions and it picked the worse. Placement is therefore **measured** (`submenuPlacement` over
  `useMenuFit`, a pure function the jsdom suite can pin) and `narrow` only short-circuits it. Hover
  inverts with it: inline, the row is a **toggle**, because "opens and does not toggle" holds only
  while something else has already opened it. A **top-level** menu is *nudged* rather than
  re-anchored (`menuShift`), and it must measure **`documentElement.clientWidth`, never
  `window.innerWidth`**: on a phone `innerWidth` is the visual viewport at minimum scale, so a panel
  hanging off the right widens the document and the number grows to include the overflow being
  measured. An open panel takes the **screen**, off stamped attributes and **never `:has()`**, so
  "both open, the inspector wins" is a selector rather than a fact about source order. What none of
  this touches is **touch**.
- **Small screens get a notice, not a layout, and it stands the guides dialog down.** A media
  query, not a UA string, asking **both axes** since a phone in landscape is wide. Silent half: the
  guides dialog returns null here, or mounting behind this spends a first visit's one appearance on
  a modal nobody saw. Invisible to every other `App` suite, jsdom's `matchMedia` answering `false`
  to everything. The acknowledgement records **that** the reader answered, never the size.
- **`overflow-y: auto` clips the other axis too**, so a `Dropdown` holding a flyout submenu must
  pass `flyouts` to switch the panel's scroll off, or the submenu renders as a horizontal scrollbar.
  And **a shortcut's glyph is stored by meaning, not as text** — `src/ui/shortcuts.ts` is the one
  table, `formatChord` the only place that knows ⌘ from Ctrl, and `Editor.tsx` still owns the
  *bindings*.
- **A message that names a remedy has to be reachable, and on a card nothing is.** React Flow puts
  `user-select: none` on every node, so an error naming the form that lifts a refusal was a URL
  somebody had to retype by eye. `IssueText` is the one component the card, the inspector and the
  Connections alert render through, and the text carries `user-select: text` **and** `nodrag`
  (without the second, the drag that starts a selection moves the node). Its rule: **the visible
  text is the href**, because the URL is read out of whatever deployment a Custom node points at and
  a mismatched label is the only thing an anchor can lie about; `http`/`https` only, so a server
  cannot write `javascript:` into an error body and have it linked.
- **A dialog that opens itself while a tour is running is a dialog nobody can use**, driver.js
  making everything but the spotlit element `pointer-events: none`. Panels ask `isTourActive()` and
  send the message to the status bar instead; the tour asks for a credential in a step of its own,
  with an `after` that closes the panel — Next has to be a way out. Second half: **an anchor with a
  `??` fallback resolves *instantly***, ending driver's `waitForElement` poll before React has
  committed, so the spotlight lands behind the dialog. **`TourStep.when` is asked once, at start**,
  because `go` indexes into the filtered list.
- **The launch sequence is one boolean and a stage.** `startPageOpen` means the sequence is
  showing, `guidesOpen` that it is at its first stop, and `useLaunchStage` is the only place both
  are read — a second independent boolean would have taught the toolbar, the share link and thirty
  tests about a modal they close today for free. Shown **once ever**, written on *sight*. A guide
  taken from it returns to it, one from the `?` menu ends on the canvas. A **checkmark means
  finished**: only walking off the end sets it, since ×, Escape and every other dismissal reach the
  same hook.
- **The fourth guide has no steps, and its labels are placed rather than authored.** The Screen Map
  boxes every control at once and hangs a one-sentence label off each — a tour walks and this one
  *waits*, which is why closing it is what earns the checkmark. The engineering difference from a
  hand-placed figure is the whole problem: this labels the running app at every width, so the
  placement is computed and is the part that can be wrong with nothing failing. Hence `mapLayout.ts`
  is **pure over rects handed in** (jsdom lays out nothing) and `pnpm probe:screen-map` asks the same
  properties of a real screen. Four measured findings, three of them wrong first: a row is **filled
  sideways before it is dropped**; a next row is a label's **own height** down, not a fixed step; the
  band is **the row, not the side**; and the lattice **can be full while the window is not**, so the
  last resort is the position that collides *least*. Nothing is ever dropped. Three more: **a spot
  that is not on screen is not on the map**, which is the feature, and mounting the real `App` is
  what stands between a renamed anchor and a hole; **hovering either end of a leader lights the
  triple**, tied by `data-spot` since lighting the right number of things while pairing them wrongly
  looks right in a screenshot; and **React runs layout effects child-first**, so the stage is held
  back one commit or it measures before the borrowed inspector exists. Below `NARROW_QUERY` it
  stands down to a **list**. What it must **not** do is re-derive what a guide already knows — the
  anchor vocabulary and the borrow/restore helpers live outside the driver.js `import()`, or the
  Guided Tour's step prose lands in the main chunk. **A node body can carry a map of its own**, and
  three traps are specific to that: its finders are **scoped to the surface's body**; it is
  **portalled**, `backdrop-filter` being the containing block for fixed children; and it is on
  `useOverlayEscape`'s stack **above the viewer**.
- **The memory readout's limit is half of a ceiling, and Chrome's is the only measured number.**
  `performance.memory` is live on a served page and **frozen on `about:blank`**, where a probe
  concludes it reports nothing. Typed arrays count towards `usedJSHeapSize` but **not** against
  `jsHeapSizeLimit`, while ordinary objects ended the tab well below it — so the meter subtracts the
  typed arrays held. Everything else is `core/valueBytes.ts`' estimate, and `ByteLedger` charges
  each array and buffer **once**: a duplicate workflow adopts its original's cache, so a per-holder
  sum double-counts in exactly the case somebody is deciding what to close.
- **A run notification is opt-in, but the tab title is not, and the fallback is the feature.**
  `Notification.requestPermission()` is refused outside a user gesture, so the bell's *click* is the
  prompt. **`denied` is terminal** — a page can never ask twice and hears nothing when the user
  relents, so the bell's pressed state is the stored preference **and** a live `notifyState()`.
  Three engines will never show one anyway, so `flashTitle` runs unconditionally and captures the
  title it replaced **once**, or the tab says "Run finished" for the rest of the session. Away is
  `visibilityState` **or** `!hasFocus()`, a covered window still being `visible`.
- **A pinned viewer is a grid column, and one node is never live in two full-size surfaces.** `⇥`
  docks a viewer beside the canvas rather than over it, so the card stands down for `pinnedNodeId`
  exactly as for `expandedNodeId` — the same three WebGL contexts. The store refuses one id in
  *both*; two different nodes it allows. The canvas column is **`minmax(0, 1fr)`**, React Flow's
  pane reporting the whole graph's extent as its automatic minimum. The stored width is a
  **fraction** of the window under a **px** floor, and *which* node is pinned is deliberately not
  stored, a node id meaning nothing in the next graph.
- **A second workflow is a second `Scheduler`, and a switch is `loadGraph` keeping the half it used
  to throw away.** Four rules. **A Scheduler each, not one shared**: `newId` is unique within a
  *session* and `deserializeGraph` does not remap, so two documents from one file share node ids
  *and* provenance keys, and one cache would report the second copy as already run. **Freshness is
  derived**, so `refreshStates` on arrival recovers every badge with no run and no fetch. **The
  viewport is captured on `onMove`, not `onMoveEnd`** — a gesture-end never fires for a document
  only ever `fitView`ed. **Every open route mints a document**, reusing a blank *and historyless*
  canvas so a fresh visit strands no empty tab; that retired the replace-confirm outright, deleted
  rather than neutered. **`newGraph` stays the in-place reset** twenty-three suites use.

### Persistence and documents — [docs/persistence.md](docs/persistence.md)

- **A run state is derived, and boot was the one path that never derived it.** `refreshStates`
  compares each cache entry's key against the one the graph now wants, which is why `loadGraph` and
  `switchDocument` both end in one; the store's initialiser did not, so a reloaded workflow came up
  all `idle` — a disabled Run button on a graph with no results. **The canvas had been hiding it by
  accident**, React Flow's mount commit running the refresh, so only a route that opens *without* a
  canvas could show it. Two rules from the fix: **nothing in the store's initialiser may notify the
  host** (zustand assigns state from what the initialiser *returns*, so a `set` there is handed
  `undefined`) — answered by *position* rather than a readiness flag; and **deriving is not
  running**, starting queries because somebody reloaded a tab belonging to auto-run on the next
  edit. `refreshStates` also **skips its key pass on an empty cache**. The general shape is worth
  keeping: **a second surface is how you find out which invariants the first one's side effects
  were quietly maintaining.**
- **The open set survives a reload in two stores, and the split is about *when* the answer is
  needed.** The active document stays in the `localStorage` slot, because the autosave is read
  synchronously in the store's initialiser and decides the first paint — an IndexedDB read there
  boots every visitor onto a blank canvas to serve the ones with four workflows open. Every *other*
  open document is IndexedDB, because the tail exceeds the 5 MiB quota and the write swallows the
  overflow, so the failure is an open set that silently does not persist. Four rules.
  **`loadActiveDocId` is `sessionStorage` and synchronous**, giving the slot's graph its identity in
  the same tick — without it a second `createDoc` **replaces** the live record rather than adding
  one, which keeps the row count right and stops a rename reaching the switcher. **The restore is
  additive and never activates**, so a share link followed before it lands is safe. **A document is
  written at the two moments its content can change.** **A duplicated tab takes the whole set with
  it.** Fifth, because the bounds differ: past `MAX_SLOTS` a tab loses its slot and keeps its
  session, and the shared-key fallback then hands over another tab's graph — a recognisable
  degradation for one workflow and a *coherent-looking set with one foreign workflow in it* for
  several, so `fromSlot` says which answered. Found at eight open tabs in a browser, not by reading
  the code. The autosave is also the one `serializeGraph` caller passing **`compact`**;
  byte-identity across paths was never a property, every call stamping a fresh `modifiedAt`.

### The dashboard — [docs/dashboard.md](docs/dashboard.md)

- **A dashboard cell is a reference to a node id, and the grid replaces the canvas rather than
  covering it.** `D` swaps `Editor` for `DashboardView` in the same grid area, so React Flow
  unmounts and every card's preview goes with it — the swap trades WebGL contexts rather than
  adding them. Hence **at most one cell per node, and only nodes that can be drawn**, enforced in
  `addCells` *and* `validDashboard`, a hand-edited file being the other way each arrives. The dock
  does not render while the grid is up. **Order is position** — no `x`/`y`, flow is not `dense`, so
  a gap is visible rather than CSS reordering the list somebody just dragged. The **layout is in the
  document**, inverting the dock's rule on purpose: these ids belong to *this* graph — kept
  invisible to anyone not using it by three rules: written **only when true**, a mode toggle
  **cannot mint a layout**, and it is **not an undo step**. Every dashboard action is **live under
  the lock**. The row height is **measured, not `1fr` and not `vh`** — `1fr` shortens every row as
  one grows, so the resize handle visibly does nothing — and is painted onto the element, never into
  state.
- **A cell is on screen before the run**, so the viewers that draw from their *inputs* read
  `nodeInputs` in `ViewerSurface`, memoised on the graph object and `previewVersion`, the two things
  a *run* does not move. **Not a better dep and not a memo**: `runVersion` buys back the same class
  of bug. Two things not to undo — `previewVersion` is subscribed **ungated** here, where the card
  gates on `isViewer`, because a non-viewer node can hold a cell; and the test must run
  **underneath** a mounted grid, the one order that can see it.
- **A run's denominator is its *scope*.** The grid draws values rather than badges, so it is the one
  surface with no run indication, and its bar reads `Scheduler.runProgress()` — `resolveScope` being
  the only thing that knows a cell's `▸` covers three of four nodes. A loop is **not one step**, a
  **failed** node is as far behind you as a successful one, and the bar lives in the *header*, the
  row height being measured. Three things found by building it: the ordinary walk **announced
  nothing** between a run's start and its end; fixing that on `onStateChange` is the **expensive**
  spelling, so **`onRunProgress`** is a third channel doing the least a host can do; and
  `useRunProgress` returns the Scheduler's own object, a selector minting `{done, total}` being an
  infinite render. A step is also **not the smallest unit** — the node currently running folds in
  its own `ctx.progress` fraction, raised-never-lowered and **top-level only**. The bar **pulses
  while determinate**, length alone not being tellable from a hang, and `coda-pulse` is one keyframe
  at **one** depth for all three callers: a shallower swing was taste, was reported as invisible,
  and measured under the 3:1 floor.

### The scheduler and loops — [docs/core.md](docs/core.md), [docs/loops.md](docs/loops.md)

- **A `reference` port that resolved to nothing is refused by the scheduler, and the two states it
  tells apart are invisible to the node.** `datasetIdentity` hands `evaluate` the same `undefined`
  for "nothing wired" and "a wire whose dataset node cannot yet say which dataset it is", so a
  reader refuses in the only words it has — *Wire a CAVE Dataset* on a card with a Dataset wired to
  it. **The ordering references exist for is what made it undiagnosable**: those nodes run
  *upstream* of the dataset node, so the run stopped there and the dataset node's own accurate
  sentence was never reached. So `gatherInputs` composes `GatheredInputs.refusal` from the
  **referenced node's** inference issues, checked after `blocked`, **after the auto-pass deferral**
  and before `evaluate`; no reason at all means a cold listing, which is not an error, so that
  sentence says *Run again*.
- **A loop is one number in a hash, and the region is derived from the wires.** `For Each` has no
  sub-graph: `Scheduler.loopIndex` is folded into the begin node's provenance key, so advancing it
  re-keys every descendant and invariant 4 re-runs the region. Hence: the loop executes at the
  **last** node of its region; a settled loop does not re-run, so the index is left at `count - 1`
  rather than reset, while a **cancelled** loop needs `loopDone` to stop it settling half-processed;
  a `Collect` is the one node a cache hit must never answer for mid-pass; and `RunSummary.executed`
  is a set of node ids, so per-pass files come through the awaited `SchedulerHost.onIteration`.

### The wizard, the pages and the help — [docs/wizard.md](docs/wizard.md), [docs/pages.md](docs/pages.md), [docs/help.md](docs/help.md)

- **The Workflow Wizard replaced the bundled examples, and its option space is gated rather than
  offered.** Four questions and `buildWorkflow` assembles the chain, each narrowing on
  `capabilityAnywhere` and on what the analysis *produces*; `VIEWS` is that pairing **and** the node
  each pair ends on, one table read by both halves. The view question takes a **set**, opens with
  **every box ticked**, and what is remembered is the **refusals** — this question's options change
  with the analysis, so a stored allow-list means something different every time it is read. Every
  answer's row draws a **node's** glyph, and a glyph fails silently *upwards* into the category
  drawing. A generated workflow asks the canvas for **one layout pass** on arrival, which cannot be
  done in the builder because **only the canvas knows how big a card is**; it is a request from a
  *builder*, never a property of opening, so it must run ahead of the branch where `loadGraph`
  stands auto-layout down. Four traps: **it asks the ceiling, not the floor**, a wizard answer being
  a *family* with no dataset id yet; **`capabilityOf` answers `true` for an unregistered source**,
  so anything enumerating combinations at module-init or SSR time must register first; a generated
  search is **capped**; and `demoWorkflow()` is what the tour's empty canvas and thirty test files
  load, so the suites exercise the graph that ships.
- **The wizard's first question has a fifth kind of answer, and the mode is derived from it.**
  `WizardAnswers.datasets` is a **list at every arity** and `isMulti` reads its length: a `multi`
  flag beside it is a second answer to a question the list already answers. The two analysis lists
  are **disjoint** and gated per *chosen dataset* rather than per first one; a template space is a
  **second gate**, not foldable into `SourceCapabilities`, a space being a fact about coordinates
  bound to a dataset id. The third question is the one that can come back **empty** — two
  connectomes sharing no capability share no analysis — so it is a refusal on Continue. Three silent
  failures: a chain's ids are local to it, so `prefixChain` rewrites a **whole chain** rather than
  threading a prefix through its readers; every dataset meets on **one variadic `Stack Neurons`**,
  since a stack throws on a source column an input already has; and a row count is **not another
  row raised**, the extra row being the Description companion that a head-clearance band put on top
  of the next dataset — found at four datasets, invisible at two.
  See [docs/comparative.md](docs/comparative.md).
- **A dataset that keeps its cell typing in a table needs a chain in front of it, and that chain is
  a declaration rather than a graph.** Written as bespoke starter graphs, one dataset answered one
  question two ways depending on the menu you came through, and the assistant could not know the
  chain existed at all. `DatasetFamily.annotationChain` is the one declaration, and **only the
  origin and the step belong to the builder** — that line was first drawn at "placement", and both
  builders promptly invented structure the declaration knew and did not state. A row is a fact about
  the chain, a step is a fact about a canvas. Four rules: the catalogue note is **generated** from
  it; it is **not baked into the node**, some links being `expensive`; **a demo build leaves it off,
  except where the demoed node *is* the dataset** (cost is not an inference issue, and a dataset
  node's demo is the graph the wizard would have built); and **the reason lives on the chain**, or a
  note saying the built-in typing is stale outlives the chain that replaced it. Fifth: **a chain
  replacing labels the dataset already has declares `staleBuiltin`**. A bare FlyWire node looks
  right on an outdated table, so it warns, worked out from the wiring rather than set at add time
  (every route and old files included), with the fix on the warning itself (`NodeIssue.fix`, drawn
  under the sentence) running `attachChain`, which places the folded **frame**, not its cards. Any
  wire on the port stands it down.
  See [docs/datasets.md](docs/datasets.md).
- **A link in a static page names a thing; it never carries one — and the search that resolves the
  name runs at build time.** Every node guide entry opens a real workflow through a `demo://`
  fragment built on arrival from the wizard's own graphs. Three findings. **Packing the graphs was
  measured and rejected** — nearly all of it would land as base64 between the paragraphs of the
  appendix, which is the half a crawler and a language model read. **The plan is in the link because
  scoring peeks**: candidates are ranked by `inferGraph`, and `inferOutputs` on a dataset node
  starts the listing it cannot answer, so searching on the click fired requests at three servers and
  put a credential dialog over a workflow about filtering a table. Seen in a browser; jsdom reaches
  none of it. And **wiring is scored, not reasoned about** — half these ports are `any`, so a
  first-compatible rule wired Mirror to a neuron table, and the viewer must be chosen from the
  node's *inferred* output. **The in-app `?` overlay carries the same button**, taking the *trail's*
  tail so a cross-reference moves it with the reader, and searching with **every dataset buildable,
  only the synthetic one scorable**. A demo also starts with a **structured search** rather than the
  wizard's first answer, auto-run otherwise painting a red card as the first thing on screen.
- **A figure that explains a card is a copy of that card, and a copy goes stale silently.** The node
  guide opens on two wired cards with parts boxed and a note on each, and **two** because the chrome
  differs. Hand-written, which is the exception to the derive-it rule (a lesson, not an inventory) —
  but the run states are read from the shared tables, and `anatomy.test.ts` holds every glyph and
  `title` against the card's source, since a renamed button leaves a guide describing a control that
  no longer says that and nothing breaks. **Labels are authored, boxes and the wire are measured**:
  where a label goes is a composition, where a *box* goes is a fact about an element, and one typed
  out drifts on a font fallback. Three traps. A box is a child of its callout so hover can light it,
  and a positioned callout is then its containing block — so the measurement needs a stage→item
  subtraction. The section is **two boxes**: a canvas at the page's own column width, and the fixed
  world centred in it that is never stretched, since widening it moves every label off the part it
  names. **A hover panel is `visibility: hidden`, not absent**, so one hanging off the right made the
  *document* wider than the viewport at every width, with a scrollbar traceable to nothing on
  screen. And the breakpoint is asked of the **stylesheet**, never restated as a `matchMedia`
  string: CSS places the labels and JS the lines, so a disagreement leaves labels pointing at
  nothing.
- **A node's "See also" is a table, because the cross-references it looks derivable from are
  one-way.** Measured across the help corpus: 105 prose links, 74 distinct pairs, **12 mutual and 62
  one-way**, 13 documents in no pair at all — a document explains its own node, so the hub nodes
  everything links *to* were exactly the ones with no way onward, and no document mentions its own
  sibling. `src/help/seeAlso.ts` states it once as **groups**, every member related to every other,
  so a set of four is one line rather than six pairs of which five get forgotten. Editorial on the
  line the generated surfaces draw: a relation derived from a shared category or socket type relates
  every viewer to every other. `seeAlso.test.ts` pins symmetry, that every entry has a document to
  open, and that **no documented node is a dead end**.
- **A thumbnail is not always a mesh.** `CoarseGeometry` is a union and `kind` is required on both
  arms — a source that omits it silently falls through to the mesh branch and draws a blank tile.
  CATMAID skeletons carry no byte ceiling on purpose, and both rasterisers share one `fitToTile`.
  See [docs/widgets.md](docs/widgets.md).

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

**Two functions, and the mark decides which — not taste.** `seriesColor` folds everything past the
eighth slot onto the achromatic `Other`; `cycleColor` comes round to the first colour instead. The
rule: **fold where the mark folds.** A bar, a slice, a histogram segment and a box all *sum or drop*
the tail into one shape, so that shape needs one colour and grey is the honest one (`foldByRank`
governs them). A node, a point or a neuron keeps its own mark whatever colour it gets, so folding
bought nothing and cost everything. `resolveColor`'s categorical branch cycles: Network, Scatter and
3D. **Cycling's cost is said out loud** in the two places it can be — `+N more` on the legend past
`LEGEND_KEYS`, on screen *and* in the exported SVG, and `colours repeat` in the caption.

**Five categorical palettes, and only `coda` is validated here.** The other four are published sets
transcribed whole, and **the order is ours and only the order** — `resolveColor` hands the leading
slots to the commonest values, so the interleaved sets are rotated to put their saturated halves
first rather than spending the two most important slots on two shades of one hue. The imported four
are one set for both themes, so the pale members are weak on the light surface — the price of the
capacity, and the param's help says so. **Adding a sixth palette means transcribing a published one,
not mixing hues**, and the heatmap's ramps follow the same rule: matplotlib's, generated by a
script, stop count measured rather than chosen. See [docs/viewers.md](docs/viewers.md).

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
- [docs/nodes.md](docs/nodes.md) — the per-node index, one section per node whose behaviour cost
  a decision, split by family: [nodes-tables.md](docs/nodes-tables.md) (reshaping, aggregating,
  joining, editing, Heatmap, Embedding), [nodes-morphology.md](docs/nodes-morphology.md)
  (skeletons, meshes, synapses, distances), [nodes-connectivity.md](docs/nodes-connectivity.md)
  (traversal, paths, influence, similarity, graph metrics, Find Neurons) and
  [nodes-io.md](docs/nodes-io.md) (import, export, ids, ZapBench).
- [docs/datasets.md](docs/datasets.md) — the family table, Custom backend nodes, the
  Description companion, auto-wiring, starter graphs. Also **datasource vs dataset**: a
  Neuroglancer Source emits a `Dataset` so the geometry nodes take it, and
  `SourceCapabilities` is the only thing keeping that honest.
- [docs/backends.md](docs/backends.md) — neuPrint, CAVE, CATMAID, precomputed. Read the
  relevant one before touching anything under `src/data`. `precomputedToHttp` is deliberately
  narrower than the source parser beside it, for a measured reason; don't widen it.
- [docs/comparative.md](docs/comparative.md) — comparative connectomics: the cell-type
  correspondence graph, type-level edge comparison, neuron-level co-clustering. Read before adding
  any node that puts two connectomes in one table; the qualified-id decision is recorded there.
  Two rules about `Match Cell Types` that a reasonable change would break: **every correspondence
  is derived** (a hand-written `A ↔ B` belongs in a downstream `Relabel`), and the one user
  assertion that *is* allowed is a **separate pass over what the matcher left empty**, never a
  relaxed `coversAll` — exempting a component there lets one named label carry a whole component
  of unnamed ones past every gate.
- [docs/neuronbridge.md](docs/neuronbridge.md) — the NeuronBridge card: Janelia's LM–EM match index read
  straight from its public bucket, why it is not a `DataSource`, and the four rules the bucket's
  layout imposes.
- [docs/annotations.md](docs/annotations.md) — labels that do not come from the connectome:
  the Annotations socket, SeaTable, Google Sheets, root-id drift.
- [docs/export.md](docs/export.md) — the notebook and R Markdown exporters, the refusal
  policy, the emitter registry, the goldens.
- [docs/python-pyodide.md](docs/python-pyodide.md) — the Pyodide bridge and the capabilities on
  it. Read before adding a Python-backed one: they all declare the same two packages, which is
  the finding rather than a coincidence.
- [docs/persistence.md](docs/persistence.md) — share links, the autosave across tabs, the
  browser shelf.
- [docs/recipes.md](docs/recipes.md) — saved sets of cards: why a recipe is a clipboard
  fragment plus **slots** (one per outside node, not per wire), how one attaches (the selection,
  never a search; reads first; all or nothing per slot; never steals an input), and why a rename
  edits the stored text rather than a read recipe.
- [docs/wizard.md](docs/wizard.md) — the Workflow Wizard: the option space, what removing the
  bundled examples cost, and the three numbers a generated graph carries. Read before changing
  what it can build.
- [docs/assistant.md](docs/assistant.md) — the AI assistant: what the model is told and what each
  line of it cost to learn. **Read before touching the prompt.** The organising rule is
  type-versus-instance — the catalogue is the cached prefix and gets facts about a node *type*, the
  graph listing gets facts about a node *as wired* — and a fix on the wrong side measures as no
  improvement at all. Two rules from there that generalise: **a fact the model has been given is
  not a fact it acts on** (the same fact measured 0/5 as a declared port schema and 7/10 as a whole
  sentence saying what to do), and **a legal plan can be a wrong one**, which is why a turn
  previews each plan and hands back the warnings it leaves on the cards. Also why there is no tool
  loop, and why five runs per side is the floor for judging a prompt change.
- [docs/mcp.md](docs/mcp.md) — the seam with `navis-org/coda-mcp`: `src/mcp/index.ts` is built
  into `dist/mcp/v1/coda.js` and deployed with the site, and the server downloads it. **Every export
  there is a public interface** with installed consumers in another repository — a breaking change
  is a `v2` directory. Also why the server is offline by default, and why the hosted server hands
  out short links rather than packed ones: a model has to retype a link, and base64 does not
  survive it.
- [docs/deployment.md](docs/deployment.md) — where the hosted MCP server is installed and configured
  (`flyem1.lmb`), and the commands to run it.
- [docs/packs.md](docs/packs.md) — node packs, the Plugins dialog, shortcuts, `requires` and parts,
  Connectome and its backend parts. **Read before adding a pack, a shortcut, or moving nodes into
  one.**
- [docs/cortex.md](docs/cortex.md) — the Cortex pack and the gallery: MICrONS cell typing, the
  depth frame and layer bounds, compartment labels, what is deferred and why.
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
- [docs/pages.md](docs/pages.md) — overview, tutorial, node guide and dataset guide. Extra vite
  entries; each must stay out of the main chunk.
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
