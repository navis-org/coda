<img src="public/logo.svg" width="72" alt="">

# Coda

**Co**nnectome **d**ata **a**nalysis — node-graph analysis pipelines for connectomic data.

Browser-based, Blender/ComfyUI-style node editor for querying and analysing connectomes.
Short term: an alternative frontend for [neuPrint](https://neuprint.janelia.org/). Longer
term: a full analysis pipeline including morphometrics.

> **Status: prototype.** The node editor and evaluation engine are real and tested, and
> **two backends are connected** — neuPrint (hemibrain, MANC, optic-lobe, male-CNS) and
> CAVE (public FlyWire FAFB), both live. A synthetic in-browser connectome is still the
> default so the examples run with no token and no network. See
> [What's not built](#whats-not-built).

## Quickstart

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

```bash
pnpm test         # 1143 tests
pnpm typecheck
pnpm lint
pnpm build        # static bundle in dist/
```

Requires Node ≥ 20 and pnpm. On a fresh machine: `brew install node && npm i -g pnpm`.
(Node 25+ no longer bundles corepack, so install pnpm directly.)

### Start by looking around

New to node graphs? The **[field guide](https://navis-org.github.io/coda/tutorial.html)** is a
single scrolling page that builds a real pipeline as you read — nodes, wires, fetching data,
Explore, the viewers, and saving your work. It is built with the app (`tutorial.html`), so it
also opens from **?&nbsp;▾ ▸ Field Guide** in the toolbar and from the welcome screen.

Then the **[node guide](https://navis-org.github.io/coda/nodes.html)** (`nodes.html`, **?&nbsp;▾ ▸
Node Guide**, and a link in the add-node browser) is the reference half: every node grouped by
where it sits in a pipeline, searchable by socket type or setting name, each one showing its
sockets, its settings and the card it draws on the canvas. It is generated from the node registry
at build time, so it cannot drift from the app — see
[docs/adding-a-node.md](docs/adding-a-node.md) if you are adding one.

**New ▾** offers an empty canvas or a graph already pointed at a dataset, which builds
`Dataset → Explore → Table`.

Dataset nodes are per dataset — `Add ▶ Dataset ▶ MaleCNS`, `▶ Hemibrain`, `▶ MANC`,
`▶ Optic Lobe`, `▶ FlyWire FAFB` — so there is no backend to choose. Each has a **version**
dropdown defaulting to the newest release the server reports (named, so it reads
`Latest (v1.2.3)` rather than leaving you to guess), and a preview slot at the top.
`Add ▶ Dataset ▶ Custom neuPrint` takes a server and a dataset id by hand, for a deployment or
release this build has never heard of.

**FlyWire comes through [CAVE](https://caveclient.readthedocs.io/) rather than neuPrint**, so it
wants a CAVE token (Connections ▸ CAVE — the same one `caveclient` keeps in
`~/.cloudvolume/secrets`) and its version dropdown names a **materialization** rather than a
release. Coda downloads its cell annotations once per dataset and searches them locally, so the
first query waits a few seconds and every one after it is immediate. Neurons and connectivity
work; skeletons, meshes, synapses, paths and per-region counts are not wired up yet, and the
nodes that need them say so rather than failing.

Every published dataset node arrives with a small **Description** card wired to it: what the
dataset covers, the project's landing page and companion viewers, and the papers its authors ask
you to cite — as neuPrint publishes it, so it is never a second copy that can go stale. It is an
ordinary node, so delete it if you do not want it, and `Add ▶ Dataset ▶ Description` brings it
back.

The synthetic connectomes are dataset nodes too, so everything below works with no token. They
come without the card — there is nobody to cite for a connectome generated in the browser.

**Explore** is the node for when you do not yet know what to ask for. It holds a dataset's
entire neuron table, searches every field as you type, pages through the results, and lets you
tick neurons to send downstream:

```
DNp01                     matches any field, fuzzily
"giant fiber"             quoted phrase
!fragment                 exclude
class==sensory            per-field equality
status!=Traced            …including neurons with no status at all
post>1000  size<=5e6      numeric comparison
type~^LC[0-9]+$           regular expression
```

Terms are combined with AND, and field names and values autocomplete. The search runs against a
local copy of the dataset index — downloaded once (male-CNS is 165k neurons, ~7 MB gzipped,
about five seconds) and cached — so filtering is instant and costs the server nothing. Rows show
a thumbnail rendered from the neuron's coarsest published mesh, which needs no token.

Three outputs: **Hits** is everything matching the query, **Selected** is only the neurons you
ticked, and **All** hands on the downloaded index untouched — the dataset's whole
neuron-by-property table, ready for a group-by or a chart without a second trip to the server.

The editor opens on an example graph. **Examples ▾** in the toolbar has three:

| Example                        | What it answers                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| LC outputs by partner type     | Which central-brain types do lobula columnar neurons drive, ranked by synapse count |
| LC → descending neuron matrix  | Row-normalised connection matrix between two neuron sets, as a heatmap              |
| Kenyon cell innervation by ROI | Where KCs receive input, split by subtype, as a stacked bar chart                   |
| LC circuit network             | Type-level connectivity as a node-link diagram, laid out feed-forward               |
| LC4 morphology in 3D           | Skeletons and synapse locations in 3D, coloured by type and polarity                |

Each example carries **text notes** — an overview above the chain and a step note or two under
it — so opening one explains itself rather than only demonstrating itself.

### Text notes

`Add ▶ Utility ▶ Text` puts a framed block of markdown on the canvas. It has no sockets, no run
button and no state, because it is not part of the pipeline: it is the place for what the graph
cannot say about itself — why this cell type, why this threshold, what to look at in the chart.

Double-click to write, click away to keep it, `Esc` to abandon the edit. Drag it, resize it and
delete it like anything else, and it is saved with the graph, so a workflow handed to someone
else arrives explained.

The inspector carries one control for it, **Outline**. Off drops the frame, the paper and the
shadow together, leaving the text on the canvas — a caption rather than a card.

### The canvas is the default

The right-hand **inspector** and the **minimap** both start collapsed, and the choice is
remembered. Reopen the inspector from the toolbar (the lens icon) or with `I`; the minimap from the button in the
bottom-right corner, where the map itself appears.

## How it works

### Hybrid evaluation

Nodes declare a cost, and that decides when they run:

- **cheap** (filter, sort, group-by, join) re-run automatically ~180ms after you stop
  editing. Drag a threshold and the table updates live.
- **expensive** (anything that hits a backend) go **stale** and wait for **Run** (⇧R).

The **Auto-run** checkbox beside Run opts out of that split: every change re-runs the whole
graph, expensive nodes included, debounced so a burst of edits sends one query rather than one
per keystroke. Off by default and remembered, so an expensive workflow stays on manual.

This is deliberate: pointing a reactive editor at a shared production Neo4j would fire a
query per keystroke. Stale nodes are marked, and the Run button shows how many are waiting.

Freshness is decided by **provenance keys** — a hash of (node type, params, upstream keys)
— not by comparing data. So editing a param invalidates its downstream chain instantly,
and _undoing_ that edit makes the old cached results valid again with no re-query.

### Typed sockets with schema propagation

Sockets carry a type, and tabular types carry their **column schema**. Both are resolved at
edit time, before anything executes, which is what lets the editor:

- refuse links that cannot work (`Table` into a `Matrix` input) with a reason,
- populate column dropdowns from the actual upstream columns,
- offer dtype-appropriate operators (`≥` on a numeric column, `matches regex` on text),
- recompute a Group By node's output columns as you change its aggregation — so downstream
  pickers update before a single row is touched.

Socket appearance encodes type as **colour + shape + a visible label**. Colour alone is not
enough: only three chromatic families clear the colourblind-safety gate for
sockets that may appear side by side (validated, not guessed — see
[`src/ui/colors.ts`](src/ui/colors.ts)), so shape carries the rest.

### Collections

Every node operates on the **whole collection** by default — a Connectivity node fed 500
neuronIds issues one batched request. Per-item logic is meant to be an explicit `ForEach`
node wrapping a subgraph (not yet built; nothing needs it yet).

### Data sources

Nodes never talk to a backend directly. They resolve a `Dataset` value to a `DataSource`
([`src/data/source.ts`](src/data/source.ts)) and call that interface. There are three —
the synthetic connectome, neuPrint and CAVE — and adding a fourth means implementing the
interface, not touching node code. What a source *cannot* do it declares in
`SourceCapabilities`, and the nodes that need it decline at edit time rather than failing at
run time: that is why CAVE arrived with no skeletons and nothing else had to learn about it.

The one non-obvious requirement: a source must declare its column schemas **statically and
synchronously**, because schema inference runs at edit time. A source that only learns its
columns after a query can't participate in the type system.

## Connecting to neuPrint

1. Get a token from [neuprint.janelia.org/account](https://neuprint.janelia.org/account).
2. **Connections** in the toolbar — the branch icon → paste it → **Test** → **Save**.
3. On a Dataset node, switch **Source** to neuPrint and pick a dataset.

Thirteen datasets are live, including `hemibrain:v1.2.1`, `manc:v1.2.3`, `optic-lobe:v1.1`
and `male-cns:v1.0`. Find Neurons, Connectivity, Adjacency, ROI Counts, Skeletons, Synapses
and the Cypher node all work against them.

**How a request gets there.** A deployment is tried **directly** first, and falls back to a
same-origin proxy path when the browser refuses the cross-origin call. Which one works is a
property of the deployment: neuPrint historically sent no CORS headers at all and answered its
preflight with 401 before CORS handling would run, so nothing could call it from a page.
Janelia has fixed that on `neuprint-test.janelia.org` — the public deployment does not have it
yet, so it still goes through the proxy that `pnpm dev` and `pnpm preview` serve at
`/neuprint`. Coda works this out by trying, because a browser reports a CORS refusal as an
indistinguishable network error, and remembers the answer per deployment.

The consequence worth knowing: against a CORS-enabled deployment a **static build needs no
proxy at all**, so a GitHub Pages deploy can run real queries. Against the public deployment
it still does, and **Connections → Base URL** is where you name your own. Leave that field
empty otherwise — empty means "work it out", and the first attempt against a proxy-only
deployment logs one CORS error to the console before falling back.

If **Test** reports _"Nothing is serving /neuprint"_, the request never left your machine —
the path isn't being proxied. Check it directly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: application/json' \
  http://localhost:5173/neuprint/api/dbmeta/datasets
# 401 = proxy works, neuPrint just wants the token (expected here)
# 404 = nothing is proxying that path
```

The token is kept in this browser's local storage and is never written into a saved graph.
A 401 anywhere opens the Sources panel with the reason, so the first failure shows you the
fix rather than a red node.

### Dataset-specific columns

neuPrint datasets don't share a neuron schema, so Coda learns each one's shape on connect
and column pickers show what that dataset actually has: `cellBodyFiber` and `somaRadius` on
hemibrain, `hemilineage` and `birthtime` on MANC. Where a dataset publishes its property
types Coda reads them; hemibrain publishes none, so a sample of real neurons is used
instead. ROI flags are excluded — a neuron carries a boolean per innervated region, which
on hemibrain is 230 columns of noise.

### Meshes

Surface meshes come from the neuroglancer buckets each dataset publishes — **no token, and
usually no proxy**: hemibrain, MANC and optic-lobe serve them with open CORS, so they work
even in a static build where the Cypher API cannot reach. male-CNS's bucket sends no CORS
headers, so those requests fall back through the dev proxy automatically.

| Dataset                     | Format                         | Detail levels |
| --------------------------- | ------------------------------ | ------------- |
| hemibrain, MANC, optic-lobe | sharded multi-resolution Draco | 4             |
| male-CNS                    | flat legacy mesh               | 1             |

Where a dataset offers levels of detail, the **Detail** param on the Meshes node is a
triangle budget for the whole set, and the coarsest level that fits is used — so asking for
forty neurons gets you forty coarse ones rather than a stalled tab. **Max neurons** is a
separate guard rail: it bounds how many are _fetched_ (roughly three requests each), not how
heavy they are. The exception is a single-level source like male-CNS, where every neuron
arrives at full resolution — a few megabytes each — and the count is the only control. One hemibrain neuron
spans 2.0 MB at the finest level and 10.8 kB at the coarsest, a 185× range. The 3D caption
shows `mesh LOD n/m` so a coarse surface never looks like a broken renderer.

Geometry is normalised to **nanometres**. neuPrint returns skeletons and synapses in 8 nm
voxels while meshes arrive in nm; without conversion a mesh sits 8× away from the skeleton it
wraps. One consequence: `cableLength` is in nm, and skeleton coordinates are 8× the values
the neuPrint API returns.

### Cypher

The **Cypher** node runs a query as typed and turns whatever comes back into a table, with
column types read off the values. Its columns can't be known until it runs, so downstream
pickers stay empty until the first result — then populate. That schema isn't saved, so
after a reload it's unknown again until you re-run, the same lifetime as the results.

Queries go to a shared production database as written. There's no client-side limit or
keyword filter: `Find Neurons` with `limit: 0` really does ask for every neuron.

## Navigation & keyboard

**Mouse:** left-drag on empty canvas **pans**; `⇧`+left-drag draws a **selection box**.
Middle and right drag also pan. Scroll zooms.

| Key                               | Action                                                                   |
| --------------------------------- | ------------------------------------------------------------------------ |
| `Tab` / `⇧A` / **+ Add**          | **Node browser** — big centred picker with previews and category filters |
| `Space`                           | **Command palette** — fuzzy search over commands _and_ nodes             |
| double-click / right-click canvas | Compact palette, prefilled `Add:` so only nodes are listed               |
| drag a link into empty canvas     | Palette filtered to nodes that accept the dragged type                   |
| `⇧R` / `⌘⏎`                       | Run all stale nodes                                                      |
| `M`                               | Mute selection                                                           |
| `H`                               | Collapse selection                                                       |
| `⌘D`                              | Duplicate selection                                                      |
| `⌘Z` / `⇧⌘Z`                      | Undo / redo                                                              |
| `I`                               | Show / hide the inspector                                                |
| `F` / **⛶**                       | Fullscreen — the browser's tabs and address bar gone                     |
| `⌫`                               | Delete selection                                                         |
| right-click a node                | Run just that node, invalidate its cache, mute, delete                   |

### Filling the screen

`F`, or the **⛶** beside the theme toggle, hands the page to the browser's Fullscreen API —
the same thing `F11` does, reachable from inside the app. Coda's own toolbar and status bar
stay: what it reclaims is the browser's chrome, and the stale count and **Run** are exactly
what you want in view while a graph is running. `Esc` leaves.

For the permanent version, Coda ships a web manifest and can be **installed**: Chrome and Edge
offer it from the ⋮ menu (_Cast, save and share ▸ Install page as app_, or an install icon in
the address bar), Safari from _File ▸ Add to Dock_. An installed copy launches in its own
window with no tabs and no address bar at all. It is the same app from the same origin, so it
shares the token, the browser shelf and every cache with the tab.

A running node is outlined by a pulsing **gold** stroke, just outside the card, that **grows
around its perimeter** as the work progresses — a fifth of the way round while mesh manifests are read, the rest as the geometry
arrives. Where a node can't say how far along it is, a short arc travels round instead, since a
full outline would read as finished. Both respect `prefers-reduced-motion`.

Each node header has a **▶ Run** button that evaluates that node and whatever it needs. It
is disabled when the node is already up to date — a node's provenance key covers its
upstream, so `ok` means there is genuinely nothing to recompute. While a node runs, ▶
becomes ■ to cancel.

Palette rows are breadcrumbs, with only the name in full-strength ink:

```
Add ▶ Table ▶ Filter        ▶ Keep rows matching a condition on one column.
Run ▶ Clear Results         ▶ Drop every cached result so the next run re-fetches
View ▶ Theme ▶ Dark
```

It reaches Run All, Run Selected, Cancel, Clear Results, undo/redo, mute, collapse,
duplicate, delete, new/open/save, fit view, theme, the examples, and every node type.
Typing initials works: `ra` → Run All, `cr` → Clear Results, `gb` → Group By.

The first breadcrumb segment doubles as a **filter prefix**: `Add:` lists node insertions
only, `Run:` only run commands, and so on. It's a real filter rather than a mode — delete
the prefix and the search widens back to everything.

### Node browser

`Tab` (or **+ Add**) opens a full-size picker instead: search on top, category chips under
it, then one row per node with a **thumbnail** of that node — category-tinted header, its
real input sockets down the left and outputs down the right, in the same colour-and-shape
grammar as the canvas, plus a category glyph. Each row also states the node's port
signature (`Dataset + Neurons → Table`) and whether it needs an explicit Run.

Thumbnails are derived entirely from the node definition, so a node added later gets a
correct preview with no artwork to draw.

Chips and search are mutually exclusive by design: typing clears the active chip, picking a
chip clears the query. That removes the worst failure of a combined filter+search — an empty
result with no visible reason, because you forgot a filter was on.

Number fields drag horizontally to scrub (hold `⇧` for fine control), or click to type.

## Output widgets

Every output widget (table, heatmap, bar chart) has a caption bar with:

- **⤓ Download** — CSV for tables, wide CSV for matrices (`pandas.read_csv(index_col=0)`
  shape), and additionally **SVG** and **PNG** for the charts and the network. Filenames
  combine the graph and node names, e.g. `lc-outputs-by-partner-type_table.csv`.
- **⤢ Expand** — opens the result full size in an overlay, with a **⛶ Fullscreen** button
  inside for a true no-chrome view. Also reachable from the node header, by double-clicking
  a node's inline preview, from the inspector, or via `Space` → "Expand Selected Output".
  `Esc` closes.

The overlay's top rail exposes that viewer's _presentational_ params — colour scale, page
size, stack-by column — so you can restyle a result while looking at it full size. Those
params are excluded from the provenance key, so fiddling with them never marks the graph
stale or invalidates anything downstream.

Tables page rather than truncate: first/prev/next/last, `rows 201–400 of 12,480`, and a
per-page selector. Clicking a column header sorts **the view only** — the footer says so,
because a viewer sort looks identical to a Sort node's effect but nothing downstream sees
it.

### Network and 3D

Two more viewers, both built for data-driven encoding:

**Network** ([Sigma](https://www.sigmajs.org/) + graphology, WebGL). Build one with
`Build Network`, which turns any edge table into nodes and links, derives degree/weight
attributes, and optionally joins a node-attribute table. Four layouts: force-directed,
circular, **layered** (feed-forward — the way circuit diagrams are drawn), and
**from columns**, which positions nodes by any two numeric columns, so a spatial layout
from soma coordinates is a column pick rather than a feature request.

A directed network draws **arrowheads** at the target end, and a reciprocal pair (A→B and
B→A both present) bows apart into two arcs instead of stacking one link on top of the
other — otherwise a two-way connection is indistinguishable from a one-way one. Hovering a
link shows its endpoints and weight; **Link labels** prints the weight permanently. Labels
are drawn in full while the graph is small enough to fit them all; past that the renderer
thins them and the caption says `labels thinned`, so a missing label is never a mystery.
Export is **CSV / SVG / PNG**, and the SVG is real vector: it is re-drawn from the same
numbers rather than screenshotted, so it scales, and what you export is the view you framed.

**3D** (three.js + react-three-fiber). Takes Skeletons, Meshes and Points on three typed
inputs, so neurons and their synapses share one scene. Skeletons render as a single
`LineSegments` with per-vertex colour; geometry rebuilds only when the data changes, so
restyling is cheap.

Both are lazy-loaded — three.js is a ~900 kB chunk that never loads unless a 3D view is
actually rendered.

### Neuroglancer

The **Neuroglancer** node takes a dataset and a neuron table and emits a _link_: the
scene that dataset already publishes, pointed at those neuron ids and coloured by a column.
The node body is an iframe on that link — a live viewer on the canvas, not a button that
opens one. Drag its corner to make it as big as you need; the size is saved with the graph.

Layers you hide, layers you add and the camera you set up **survive an upstream change**: Coda
reads what the viewer is currently showing, puts the new selection into that, and hands it back.
That needs the viewer served from the same origin, which is what the `/ng` proxy rule in
`vite.config.ts` is for — without it the embed still works, it just restores its own layer list
each time. The link the node emits is unaffected either way: always an absolute public URL.

Changing something upstream **updates the selection in place**: the neurons change, and the
camera, zoom and panel layout you set up stay where they are. That takes neuroglancer's `#!+`
merge form — the ordinary link form makes it reset first, which is why an edit three nodes away
used to throw away your framing. What a merge still cannot carry over is per-layer state the
viewer owns, like a visibility toggle or a randomised colour seed; those are rebuilt.

A couple of the published defaults are overridden for an embed: the axis lines are off (they
cross the volume and read as anatomy), and the layer side panel starts closed — MANC and
male-CNS both ship it open, which costs most of a node-sized card. Both are opening defaults
only, so if you open the panel it stays open through later updates.

**A dataset on its own is enough.** The Neurons input is optional: wire only a dataset and
you get the published scene with nothing selected — the volume, its EM and its ROI meshes,
framed the way Janelia framed it. Neurons are what you add to it, not what it needs to
exist.

Its controls live in the inspector rather than on the card, because a row of pickers above
the embed would take a tenth of the space you opened it for. One of them is **Interface
scale**, at 75% by default: neuroglancer's toolbar and panels are sized for a full browser
window, and shrinking the frame gives the scene back most of a node-sized card. It has
nothing to do with the camera zoom inside it. Colour offers the usual modes
plus **neuroglancer's own**, which sends no colour at all and lets it hash-colour each
segment — the shortest link there is.

Reusing the published scene is the whole point. Janelia curates one per dataset — the camera
framing, the EM volume, the ROI meshes, the synapse layer wired to the segmentation — and
rebuilding that by hand would produce a segmentation layer floating in space. Only the
segments, their colours and the layout are changed.

|           | 3D View                                                         | Neuroglancer                                       |
| --------- | --------------------------------------------------------------- | -------------------------------------------------- |
| renders   | scenes Coda builds — skeletons, meshes, synapse points together | the dataset's own segmentation, at full resolution |
| geometry  | fetched into the graph, exportable, analysable                  | streamed by neuroglancer, never enters Coda        |
| encodings | every Coda encoding, on every input                             | colour per neuron                                  |
| selection | clicks feed a `Selected` output                                 | none — a foreign frame cannot be read              |

So: neuroglancer to look around, `3D View` when the picture is the thing you are making.

The whole scene travels in the URL fragment, which means the viewer instance never receives
your data, no proxy is involved, and **Copy link** produces something that opens anywhere.
Two knobs exist because of how much a published scene can carry: `Layers` can drop
everything but the neurons (male-CNS publishes 38 layers and 38 kB of state), and
`Max neurons` bounds what neuroglancer is asked to draw — nothing is downloaded by Coda.

**New ▸ <dataset>** wires one up for you wherever the source publishes a scene, hanging off
the same Explore selection the table shows:

```
[Dataset] ─┬─▸ [Explore] ──(Selected)─┬─▸ [Table]
           └──────────────────────────┴─▸ [Neuroglancer]
```

Unlike every other viewer, this node's colour params are **not** presentational: they are
baked into the link it emits, so a restyle genuinely changes its output.

### Data-driven encoding

Every encoding on both widgets goes through one shared module, so the palette rules hold
identically everywhere:

| Mode          | Behaviour                                                               |
| ------------- | ----------------------------------------------------------------------- |
| single colour | a fixed slot from the validated palette                                 |
| by category   | ranked by frequency, eight slots, a ninth folds into achromatic "Other" |
| by value      | single-hue ramp whose direction flips with the theme                    |

Sizes map a numeric column onto a range, **area-scaled** for node radii (readers compare
areas) and linear for link widths. Nulls encode as grey rather than as zero. Every
categorical encoding emits a legend, because colour must never be the only channel.

### Selection feeds back into the graph

Both viewers have a **Selected** output. Click nodes in the network or neurons in 3D and
that selection becomes a `Neurons` table you can wire into a downstream query:

```
[Viewer3D] Skeletons ●──
           Selected  ──● Neurons ──▶ [Connectivity] ──▶ …
```

This is the one place data flows backwards from a viewer, so the selection is deliberately
**not** presentational: it lives in the `.coda.json`, is undoable, and takes part in the
provenance key. Restyling never invalidates anything; selecting does, because it genuinely
changes an output.

Network node ids are strings — neuron ids at neuron level, type names at type level — so the
selection's `neuronId` column is null for a type-level pick. That fails loudly at the next
query rather than fabricating an id.

## Layout

```
src/
├─ core/          graph engine — headless, no React (lint-enforced)
│  ├─ types.ts        socket type system + column schemas
│  ├─ node.ts         the NodeDefinition contract
│  ├─ graph.ts        document model, topo sort, serialisation
│  ├─ inference.ts    edit-time type/schema propagation + link validation
│  └─ scheduler.ts    DAG executor, provenance-keyed cache, hybrid eval
├─ data/          DataSource interface + the mock connectome
├─ nodes/         node pack (query / table / output)
├─ store/         zustand document state, undo, persistence
├─ ui/            React Flow editor, param widgets, viewers
│  └─ panels/     command palette (+ fuzzy matcher), inspector, toolbar
└─ examples/      example graphs, built programmatically
```

`src/core` and `src/data` must stay headless — a lint rule blocks imports of React,
zustand, the store and the UI from those directories. The point is that the engine stays
unit-testable without a DOM, and reusable later by a non-React consumer (a CLI runner, or a
Python-side executor consuming the same graph JSON).

## Files

A graph file (`.coda.json`) _is_ the document — nodes, links, params, positions, viewport.
**Save ▸ Download** writes one; **Open** reads one back. There's no server and no accounts.
The working graph is autosaved to localStorage as a crash net, not as a project store.

**Save ▸ Save in this browser** keeps a copy on the browser's own shelf instead, in
IndexedDB. Those show up under **Open**, where they can be renamed and deleted, and on the
start page as a *Your workflows* rail. An entry is a document keyed by its name: saving
again under the same name replaces it (after asking), and renaming the graph first makes a
second one.

That shelf is a convenience, not a backup. Browser storage is per-origin and per-profile,
goes with the site data when you clear it, doesn't sync between machines, and doesn't exist
in a private window — so the file is still the durable artefact.

Unknown node types are dropped with a warning on load rather than failing the whole file,
so a graph made with a newer node pack still opens.

### Sharing a link

The **share icon** in the toolbar turns the graph into a URL, the way neuroglancer does — the whole
document goes after `#!`, so there's no server, no account and nothing to keep alive. The five
bundled examples come out at 1.5–2 kB of address, which pastes anywhere.

When a graph is too big for that — an Explore _Select all_ is the case that does it — the same
dialog uploads it to a **GitHub Gist** and hands back `#!gh://<user>/<id>` instead, forty
characters however large the workflow. That needs a token with the `gist` scope, under
**Connections ▸ Sharing** (the branch icon in the toolbar); _reading_ a shared gist needs
nothing, so a link you send works for
anybody. Pressing Share again updates the same gist, so a link already sent stays current.

Links pointing at `gs://` buckets and plain `https://` JSON files open too, though Coda can't
write to either.

The dialog says what a link doesn't carry, because none of it is obvious: rows from **Upload
Table** live in your browser rather than in the document, and a workflow on a real connectome
needs the recipient's own neuPrint token to _run_ — it opens without one. No credential is ever
inside a graph, and nothing in a shared workflow fetches anything until you press Run.

## What's not built

Being explicit, because the milestone was deliberately scoped to the editor:

- **The public neuPrint still needs a proxy, and one only ships for development.**
  `neuprint.janelia.org` sends no CORS headers, so a browser cannot call it directly and
  `pnpm dev` proxies it at `/neuprint`; a static build has nothing serving that path until you
  put an equivalent in front of it and name it in Connections → Base URL. Deployments that
  *do* send CORS headers — `neuprint-test.janelia.org` today — are reached directly and need
  none of this.
- **Meshes cover four datasets.** hemibrain, MANC, optic-lobe and male-CNS publish a
  precomputed source; the rest (banc, wasp3, fib19, mushroombody) either publish only DVID
  or nothing, and the Meshes node says so rather than failing mid-run.
- **Synapse partners are not resolved.** neuPrint models a synapse as a point that _has_
  partners; joining them is a much heavier query, so the synapse table carries
  `neuronId/type/polarity/confidence` and no `partnerId`.
- **No `ForEach` node.** The collection semantics it belongs to are implemented; the
  subgraph node and its nested-editing UI are not.
- **Tables are plain columnar arrays**, not Arrow. The accessors in
  [`src/core/values.ts`](src/core/values.ts) are the only thing that would need to change.
- **Muting blocks downstream** rather than passing input through Blender-style.
- **No virtualisation.** One DOM node per graph node, and table viewers cap rendered rows.
  Fine for tens of nodes; a 1000-node graph would need work. Explore pages rather than
  scrolling a long list for the same reason.
- **The dataset list is compiled in.** Versions, ROIs and schemas are read live from the server,
  but the _families_ Coda ships a node for are a static table — node types have to exist before a
  saved graph is deserialised, and a listing is a network call. A family added to neuPrint later
  needs a line of code; `Custom neuPrint` reaches it in the meantime.
- **A non-default neuPrint deployment needs CORS or the dev server.** It is tried directly
  first; failing that, `pnpm dev` and `pnpm preview` proxy `/np/<deployment>/…` (https to
  public hosts only), and a static build has nothing serving that path.
- **The dataset node's preview is a placeholder** — a specimen silhouette keyed to a coarse
  anatomical kind, not a rendering of the data.
- **Explore's index is per dataset and downloaded whole.** Fine at male-CNS's 165k neurons
  (~7 MB gzipped); a dataset an order of magnitude larger would want a server-side index.
- **Thumbnails skip the largest neurons.** They come from the coarsest published mesh, and a
  body whose coarsest level still exceeds 128 kB gets a placeholder instead — that is under a
  tenth of neurons, but they are conspicuously the interesting big ones.
- **Every neuron is fit to its own thumbnail tile,** so a small fragment fills the frame just
  as a giant descending neuron does. Consistent scaling would need the volume bounds.

## Next steps

1. CORS on the public neuPrint, which Janelia has already done on their test instance — that
   removes the need for a deployable proxy entirely. Until then, a Cloudflare Worker or
   similar is the fallback for a built Coda. Meshes already work without one.
2. Decode Draco fragments in a worker — a full-resolution pair is 3.2M triangles, and that
   currently blocks the main thread while it decodes.
3. Synapse partners, for connectivity-by-synapse work.
4. `ForEach` subgraph node, then the first morphometric nodes.
5. A Python compute service for `navis`-backed nodes, behind the same node contract.

## The mark

Coda's logo is the musical coda sign — a ring crossed by two lines, which is also a graph node
with four ports. Its geometry is measured off the Bravura reference music font rather than
drawn by eye, and it comes in two cuts that fail differently at small sizes. See
[docs/logo.md](docs/logo.md).

## Licence

MIT
