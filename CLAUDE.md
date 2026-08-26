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
- **A buffer handed to `callPython` is detached the moment the call is posted**, so read
  anything about it — its length above all — *before* the await. A check against a transferred
  buffer's `length` compares a real count against 0 and always fails.
- **Module init order.** `graphStore.ts` imports `../nodes` for its side effect. Without
  it, ordering in `main.tsx` becomes load-bearing and silently drops every node.
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
- [docs/viewers.md](docs/viewers.md) — every `out.*` widget, the shared export path,
  encodings, tooltips, table filtering, number formatting, the styling sidebar.
- [docs/widgets.md](docs/widgets.md) — Explore Dataset, Neuron Profile, Dataset Summary,
  ROI Viewer: the surfaces that fetch for themselves rather than reading a wire.
- [docs/nodes.md](docs/nodes.md) — per-node semantics: Pivot, Deduplicate, both import
  nodes, Combine Columns, Select One, Stack, Download, Connectivity Graph, Paths, both id
  nodes, Text notes.
- [docs/datasets.md](docs/datasets.md) — the family table, Custom backend nodes, the
  Description companion, auto-wiring, starter graphs.
- [docs/backends.md](docs/backends.md) — neuPrint, CAVE, CATMAID, precomputed meshes.
  Read the relevant one before touching anything under `src/data`.
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
