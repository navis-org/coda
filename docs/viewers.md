# Output widgets

The machinery every viewer shares — the `VIEWERS` table, export, tooltips, table filtering
and the styling sidebar — is below. The per-viewer records outgrew one file and are split by
viewer:

## [viewers-3d.md](viewers-3d.md) — the 3D viewer

- [The 3D viewer](viewers-3d.md#the-3d-viewer)
  - [The scene fills in as it downloads](viewers-3d.md#the-scene-fills-in-as-it-downloads)
  - [The camera is framed once, then left alone](viewers-3d.md#the-camera-is-framed-once-then-left-alone)
  - [`by radius`: the width the data already carried](viewers-3d.md#by-radius-the-width-the-data-already-carried)
  - [`to scale`: the same radii, in nanometres](viewers-3d.md#to-scale-the-same-radii-in-nanometres)
  - [The lights, and the debt `flat` left on them](viewers-3d.md#the-lights-and-the-debt-flat-left-on-them)
  - [Ambient occlusion, and four things a composer changes underneath it](viewers-3d.md#ambient-occlusion-and-four-things-a-composer-changes-underneath-it)
  - [Picking is opt-in, and clearing is the count](viewers-3d.md#picking-is-opt-in-and-clearing-is-the-count)
  - [One live renderer per node](viewers-3d.md#one-live-renderer-per-node)
  - [A 3D renderer is handed between surfaces, not rebuilt](viewers-3d.md#a-3d-renderer-is-handed-between-surfaces-not-rebuilt)
  - [The `Volumes` socket](viewers-3d.md#the-volumes-socket)
  - [The interactive legend](viewers-3d.md#the-interactive-legend)
  - [A colour per neuron: neuroglancer's hash](viewers-3d.md#a-colour-per-neuron-neuroglancers-hash)
  - [`by value`'s controls: the Heatmap's colour domain, shared](viewers-3d.md#by-values-controls-the-heatmaps-colour-domain-shared)
  - [Switching a whole socket off](viewers-3d.md#switching-a-whole-socket-off)

## [viewers-network.md](viewers-network.md) — Network Viewer, Network Metrics, Flow Chart, Sankey

- [Network Viewer + 3D widgets](viewers-network.md#network-viewer--3d-widgets)
  - [Shape, the channel that survives without colour](viewers-network.md#shape-the-channel-that-survives-without-colour)
  - [The prefuse layout, and why a fragmented graph is a different problem](viewers-network.md#the-prefuse-layout-and-why-a-fragmented-graph-is-a-different-problem)
- [Network Metrics: a card of numbers, and the two plots they cannot stand in for](viewers-network.md#network-metrics-a-card-of-numbers-and-the-two-plots-they-cannot-stand-in-for)
- [Flow Chart: the same material as the Network Viewer, at the other end of the size range](viewers-network.md#flow-chart-the-same-material-as-the-network-viewer-at-the-other-end-of-the-size-range)
  - [SVG rather than WebGL, and the layout inside the render](viewers-network.md#svg-rather-than-webgl-and-the-layout-inside-the-render)
  - [Why the layout is not ELK](viewers-network.md#why-the-layout-is-not-elk)
  - [A layer is not a hop, and that is the whole of the layering control](viewers-network.md#a-layer-is-not-a-hop-and-that-is-the-whole-of-the-layering-control)
  - [Four edge kinds, told apart by shape rather than by colour](viewers-network.md#four-edge-kinds-told-apart-by-shape-rather-than-by-colour)
  - [The fold is presentational, and states what that costs](viewers-network.md#the-fold-is-presentational-and-states-what-that-costs)
  - [What was checked in a real browser](viewers-network.md#what-was-checked-in-a-real-browser)
  - [What the exporters do, and what running them found](viewers-network.md#what-the-exporters-do-and-what-running-them-found)
  - [A chart's name is an `aria-label` on screen and a `<title>` in the file](viewers-network.md#a-charts-name-is-an-aria-label-on-screen-and-a-title-in-the-file)
- [Sankey: layered flow, where the width is the quantity](viewers-network.md#sankey-layered-flow-where-the-width-is-the-quantity)
  - [Conservation is measured, not assumed](viewers-network.md#conservation-is-measured-not-assumed)
  - [The shortfall belongs to the node, not to the column](viewers-network.md#the-shortfall-belongs-to-the-node-not-to-the-column)
  - [A node is a (layer, label) pair](viewers-network.md#a-node-is-a-layer-label-pair)
  - [Folding is safe here in a way it is not on a flow chart](viewers-network.md#folding-is-safe-here-in-a-way-it-is-not-on-a-flow-chart)
  - [What is shared with the flow chart, and what is not](viewers-network.md#what-is-shared-with-the-flow-chart-and-what-is-not)
  - [Colour is off by default](viewers-network.md#colour-is-off-by-default)
  - [What was checked in a real browser](viewers-network.md#what-was-checked-in-a-real-browser-1)
  - [The exporters refuse, and the reason is a dependency](viewers-network.md#the-exporters-refuse-and-the-reason-is-a-dependency)

## [viewers-charts.md](viewers-charts.md) — Scatter, Histogram/pie/box, Rank Plot, Line Chart

- [Scatter plot](viewers-charts.md#scatter-plot)
  - [Labels beside the points, and the tooltip's extra columns](viewers-charts.md#labels-beside-the-points-and-the-tooltips-extra-columns)
  - [Search, in the strip](viewers-charts.md#search-in-the-strip)
- [Histogram, pie and box plot](viewers-charts.md#histogram-pie-and-box-plot)
  - [Five charts, three nodes](viewers-charts.md#five-charts-three-nodes)
  - [The box plot's two orientations, and the one thing that knows about them](viewers-charts.md#the-box-plots-two-orientations-and-the-one-thing-that-knows-about-them)
  - [The swarm is packed, capped, and drawn last](viewers-charts.md#the-swarm-is-packed-capped-and-drawn-last)
  - [A mark is not a row, so a selection is not a set of ids](viewers-charts.md#a-mark-is-not-a-row-so-a-selection-is-not-a-set-of-ids)
  - [The caps, and what each does with its tail](viewers-charts.md#the-caps-and-what-each-does-with-its-tail)
  - [Freedman–Diaconis needs a fallback, and the fallback is the interesting half](viewers-charts.md#freedmandiaconis-needs-a-fallback-and-the-fallback-is-the-interesting-half)
  - [Quantiles are computed in value space; the kernel estimate is not](viewers-charts.md#quantiles-are-computed-in-value-space-the-kernel-estimate-is-not)
  - [A pie refuses negatives, and it is the only chart here that refuses anything](viewers-charts.md#a-pie-refuses-negatives-and-it-is-the-only-chart-here-that-refuses-anything)
  - [Selection reads as displacement, not as colour](viewers-charts.md#selection-reads-as-displacement-not-as-colour)
  - [The row scan is memoised apart from the drawing](viewers-charts.md#the-row-scan-is-memoised-apart-from-the-drawing)
  - [What was checked in a real browser](viewers-charts.md#what-was-checked-in-a-real-browser)
- [Rank Plot: a heavy-tailed measure, and the denominator every other view lacks](viewers-charts.md#rank-plot-a-heavy-tailed-measure-and-the-denominator-every-other-view-lacks)
  - [The share is the half that is not otherwise reachable](viewers-charts.md#the-share-is-the-half-that-is-not-otherwise-reachable)
  - [Where it refuses, and why that is the share and not the ranking](viewers-charts.md#where-it-refuses-and-why-that-is-the-share-and-not-the-ranking)
  - [The one thing `validate` catches that the resolver cannot](viewers-charts.md#the-one-thing-validate-catches-that-the-resolver-cannot)
  - [What was checked in a real browser](viewers-charts.md#what-was-checked-in-a-real-browser-1)
  - [What the exporters do](viewers-charts.md#what-the-exporters-do)
- [Line Chart: numeric columns against one numeric X](viewers-charts.md#line-chart-numeric-columns-against-one-numeric-x)

## [viewers-matrix.md](viewers-matrix.md) — Heatmap, Dendrogram

- [Dendrogram: naming leaves without renaming the tree](viewers-matrix.md#dendrogram-naming-leaves-without-renaming-the-tree)
  - [Zoom and pan: one axis, because the height is the data](viewers-matrix.md#zoom-and-pan-one-axis-because-the-height-is-the-data)
- [Heatmap: more cells than pixels](viewers-matrix.md#heatmap-more-cells-than-pixels)
  - [The fold is the whole of it](viewers-matrix.md#the-fold-is-the-whole-of-it)
  - [Canvas for the cells, SVG for everything else](viewers-matrix.md#canvas-for-the-cells-svg-for-everything-else)
  - [The chrome is shared, not drawn twice](viewers-matrix.md#the-chrome-is-shared-not-drawn-twice)
  - [Two things measured rather than assumed](viewers-matrix.md#two-things-measured-rather-than-assumed)
  - [The colour domain: two manual ends and a log mapping](viewers-matrix.md#the-colour-domain-two-manual-ends-and-a-log-mapping)
  - [Circles: the same number twice, and three decisions that are not the drawing](viewers-matrix.md#circles-the-same-number-twice-and-three-decisions-that-are-not-the-drawing)
  - [Zoom is a window, and the window is the fold's input](viewers-matrix.md#zoom-is-a-window-and-the-window-is-the-folds-input)
  - [Selecting a rectangle, and why it is stored as positions](viewers-matrix.md#selecting-a-rectangle-and-why-it-is-stored-as-positions)
  - [Three chords, a click, and the card](viewers-matrix.md#three-chords-a-click-and-the-card)
  - [The palettes are transcribed, and the stop count was measured](viewers-matrix.md#the-palettes-are-transcribed-and-the-stop-count-was-measured)
  - [The export](viewers-matrix.md#the-export)
  - [What was checked in a real browser](viewers-matrix.md#what-was-checked-in-a-real-browser)

## [viewers-neuroglancer.md](viewers-neuroglancer.md) — the Neuroglancer card

- [Neuroglancer](viewers-neuroglancer.md#neuroglancer)
  - [No bounding boxes, written as `bounds: false` on every volume source](viewers-neuroglancer.md#no-bounding-boxes-written-as-bounds-false-on-every-volume-source)
  - [The Neuroglancer frame is handed between surfaces, not reloaded](viewers-neuroglancer.md#the-neuroglancer-frame-is-handed-between-surfaces-not-reloaded)
  - [Coda's own neuroglancer, and the `Selected` output](viewers-neuroglancer.md#codas-own-neuroglancer-and-the-selected-output)


## Output widgets

`ValuePreview` picks a viewer by node type — `VIEWERS`, a table keyed like `NODE_BODIES`, whose
`withoutValue` entries draw from their inputs before the "No result yet" guard, and so also open
full size before their node has run (`opensWithoutValue`, which is how Simulate Model's partner list is
reachable before the first Run) — then by value kind, and forwards a shared prop bundle
(`baseName`, `onExpand`, `onError`, `compact`) so a new viewer cannot ship without export or expand.

- **Export** lives in `ui/export.ts`. CSV is chunked `Blob` parts rather than one string — a
  500k-row table would allocate ~30MB at once. SVG export clones the live `<svg>` and inlines the
  resolved `font-family`; the charts compute every colour as literal hex in JS, which is the only
  reason vector export is nearly free. A viewer that starts using a CSS variable for a fill loses
  that colour in exported files.
- **Tooltips are positioned in container coordinates, never viewport ones.** `.chart-tooltip` was
  `position: fixed` with `left: event.clientX` for the life of four viewers — correct everywhere but
  the place they are read, because a **transformed ancestor becomes the containing block for
  `fixed` descendants too** and React Flow's pane carries `transform: translate(…) scale(z)`. Right
  in the expanded overlay, hundreds of pixels adrift on a card: a dendrogram bracket at (1254, 417)
  put its tooltip at (1787, 498), a heatmap cell at (1098, 655) put its at (1693, 950).

  Two corrections, and one alone leaves it subtly wrong: make the pointer relative to the containing
  block, **and** divide by the zoom, a length inside a `scale(z)` pane being drawn `z` times as long.
  `offsetWidth` ignores transforms where `getBoundingClientRect()` has applied them, so their ratio
  *is* the zoom — the identity the auto-layout measurement leans on. `tooltipPoint()` is that,
  shared by all seven charts that draw a tooltip (the card itself is `ChartTooltip`); `NetworkViewer` never had the bug, being
  already `absolute` over sigma's container coordinates — what `.viewer`'s own
  `position: relative` comment describes. Verified in a browser: the gap tracks the
  camera at 4, 7 and 10 px for zoom 0.35, 0.60 and 0.86 — one constant 12 local px.

  The container passed must be the tooltip's **containing block** — `.viewer__scroll` for most,
  `.viewer` for the scatter, whose tooltip is a sibling of its plot box. The wrong one is off by
  that element's own offset, which on a card looks like a styling choice rather than a bug.
- **The scaffolding is shared, not copied.** `useChart` is what Bar, Histogram, Pie and
  Distribution each opened with — the measured box, the hovered mark, the `<svg>` the exports clone,
  the theme's ink and the CSV/SVG export source. `ChartTooltip` and `TooltipRow` are the hover card,
  and `ViewerEmpty` is the empty state every viewer draws. What differs between the charts — the
  plot's width and height, where a legend goes — stays in each.
- **The panel's width is a property of the node it draws** (`expandedWidth()`); its height never is.
  It inherited `.overlay__panel`'s 1500px dialog cap, which on a 1440p display fills the height and
  stops a third of the way across — the height claims a full-size read and the width contradicts it.
  `.viewer-panel` uncaps it; the table caps back per type, defaulting to full, since a scene, a
  heatmap or a table *is* the content. The inverse of `.help-panel`, narrow because prose has a
  measure. Two things go wrong past a width, and only the first is surprising: **a tile grid gains
  columns rather than size** (`.tiles` is `repeat(auto-fit, minmax(190px, 1fr))`, so Profile and
  Dataset Summary answer a 5K panel with twenty-six tiles the width of their axis labels), and
  **prose and lists have a measure** (`.overlay .markdown` holds a blurb to 70ch, and the empty half
  of an uncapped panel reads as content that failed to load). Six types are capped for one of those
  two reasons. An inline `max-width` rather than a rule per type, because one component draws every
  expandable node and CSS cannot ask which. Dropped in browser-fullscreen, where a cap would
  letterbox the panel somebody asked for precisely to lose the chrome.
- **Fullscreen** uses the real Fullscreen API on the overlay panel. `.overlay__panel:fullscreen`
  resets the backdrop padding and rounding: in fullscreen the panel *is* the root element and would
  otherwise render as a floating card with bars around it.
- **Table sorting is view-only** and shares `sortedRowIndices` with the Sort node, so null placement
  and numeric-vs-locale collation cannot diverge.
- jsdom has no `URL.createObjectURL`, no navigation and no Fullscreen API.
  `installDownloadCapture()` in `test/jsdomStubs.ts` intercepts the anchor-click download so tests
  can assert filename and content.

### Downloading a result

Two surfaces, one decision function. `ui/exportValue.ts`'s `formatsFor`/`planExport` answer what a
value can be written as and what the files are called; the **Download node**, the **viewers' caption
bar** and **every card's foot** read the same answer, so a format added once appears in all three and
none can disagree about a filename.

**A network exports as GraphML**, beside the two CSVs it has always written. Chosen over GML — the
other format Cytoscape, NetworkX, Gephi, igraph and yEd all read — because it is the only one
carrying Coda's attribute tables *with their types*: a `<key>` declares `attr.type` up front, so
`i64` arrives as a long and `f64` as a double rather than as whatever the reader infers from the
first literal, and an absent value is an omitted element rather than a zero somebody has to notice.
GML implies types by literal syntax and restricts key names to something `sum_neuronId` survives and
`pt root id` does not.

**Attributes only — no positions, no colours**, so the Network viewer and Build Network write
byte-identical files for the same network and the document says what the data says rather than what
one viewer was showing. Every reader here lays a graph out on import anyway.

Four things in the writer that each produce a plausible wrong file:

- **A null is an omitted element, never a zero** — the trap `numeric()` exists for, one step
  downstream: a written `0` is a reading. A non-finite number goes the same way; XML Schema does
  spell `NaN` and `INF`, but the readers disagree and a number nobody can compare is not worth a
  parse error. An **empty string is kept**, unlike a null, because this is a serializer: an omitted
  element reads back as a missing key and turns a blank cell into a `KeyError`.
- **XML 1.0 forbids most C0 control characters outright**, with no escape — `&#1;` is as illegal as
  the byte, so a document carrying one is *rejected* rather than read leniently. `xmlText` strips
  them; tab, newline and carriage return are legal and stay. Written as `\u0000`-style escapes for
  the reason `uploads.ts` records about its separator.
- **`id`, `source` and `target` are never repeated as attributes**, the subtraction
  `keptEdgeColumns` makes: an id written twice becomes a redundant column beside the keyed one.
- **`<key>` ids are generated (`nd0`, `ed0`), never the column name.** A key id is an XML ID and a
  column name is arbitrary text; `attr.name` is what NetworkX reads back.

Built as **string parts, not through `XMLSerializer`** — the point of chunking at 2,000 rows is that
a 20,000-node network never becomes one huge string, and a DOM is that string plus an object per
element. `exportValue.test.ts` still asserts against a *parsed* document (hence
`@vitest-environment jsdom`), because a snapshot of well-formed-*looking* XML is exactly what a file
with an unescaped `&` in a region name produces.

**CSV stays what `auto` picks**: GraphML is the better file for Cytoscape and NetworkX, a spreadsheet
cannot open it at all, and `auto` is what somebody gets without choosing.

**A network also exports as CX2**, for **Cytoscape Web**, which reads CX2 and nothing else from a URL
(`https://web.cytoscape.org/?import=<url>` — a `data:` URL works, up to the ~8 kB request line its
Apache accepts). `networkToCx2` beside the GraphML writer, offered by all three surfaces. Three shape
rules are **refusals** in Cytoscape Web's validator rather than preferences: a `metaData` and a
`status` aspect must be present; node ids are integers, so a node is its row number and Coda's id
travels as the **`name`** attribute (what Cytoscape labels by — anything else opens as unlabelled
dots; a table with its own `name` column keeps it and the id moves to `id`), always declared
`string` per invariant 8; and **every edge endpoint must be a node**, so an endpoint the node table
lacks is written as a node carrying only its id. Nulls and non-finite numbers are omitted, as in
GraphML.

**CX2 is the one export that carries positions, and only from the viewer.** It inverts the GraphML
rule on purpose: Cytoscape Web opens a file with positions as it is, and the arrangement somebody was
looking at is what they want to take across. So `ExportSource.cx2` hands `cx2Files` sigma's graph
coordinates (not the camera's, so zoom does not leak in) through the same `graphPositions` the layout
memo reads, and **the writer flips y** — every Coda layout is in sigma's y-up space, Cytoscape's runs
down, and an unflipped hierarchy reads as a different arrangement. The Download node and the card foot
write the same file from a wire, where there is no layout, so theirs has none and Cytoscape Web lays
it out. The writer **rescales** to `CX2_SPACING`·√n px on the longer side: a Coda layout spans the
same box at ten nodes and at ten thousand, and Cytoscape's nodes are a fixed ~40 px. And it puts the
layout's **top-left corner by the origin**, never its centre: Cytoscape Web opened a centred layout
with the origin pinned to the canvas's top-left corner and three quarters of the graph off screen,
where the same file anchored at the corner opens whole — valid either way, found only by loading it
in a browser. No
`visualProperties` yet — the file opens in Cytoscape Web's default style, so colours and direction
arrows do not cross.

**Open in Cytoscape Web** is the Network viewer's `↗ Cytoscape Web` caption button: a dialog with
three toggles (node attributes, edge attributes, layout), a size readout, and one Open. Cytoscape
Web's only interface is `?import=<url>`, so the file has to be somewhere it can fetch cross-origin,
and there are two places (`ui/cytoscapeWeb.ts`):

- **In the link**, as a base64 `data:` URL, under `MAX_LINK_CHARS` (8,000). Measured: the server
  refuses a request line past ~8,190 bytes; a 45-node graph with types, weights and a layout is an
  8,047-character link that opens, one node more is 8,223 and a 414. That is **30–50 nodes**
  depending on density and columns. base64 beat percent-encoded JSON by 25–30% (every `"` is three
  characters escaped, `%`/`#` twice over), and its one trap is `+`, which the query decodes as a
  space — `cytoscapeWeb.test.ts` reads each link back through `URLSearchParams` for that reason. No
  fragment (the app reads only the query) and no compression (it reads the body with `.text()`).
- **In a gist**, past that: `writeScratchGist`'s one secret gist per account, rewritten each time
  and addressed by its revision-pinned `raw_url` (see [persistence.md](persistence.md)). It needs
  the GitHub token from Connections ▸ Sharing; without one the dialog says where it goes and that
  leaving attributes out is the other way under the limit.

Three toggles rather than a column checklist, by choice. They strip columns off the *network*
(`selectTable`) rather than asking the writer to skip them, so `networkToCx2` stays one path. The
gist route **opens its tab on the click and points it after the upload** — a tab opened after an
`await` is outside the gesture and blocked, `popupSignIn.ts`'s trap — severing `opener` before
navigating, and closing the tab if the upload fails. The dialog is `Modal`'s **`portal`** case: rendered
into the document — the fullscreen element when there is one, or it opens invisibly under a ⛶
viewer — because a card clips and React Flow's transform would be the fixed-position containing
block, with React events stopped at its root, since they still bubble through a portal to the card
whose double-click expands it. The layout is read **once, as the dialog opens**, so a force layout
settling behind it does not rebuild the file every tick. And **nothing is written for a graph no
toggle could fit** (`mayFitInLink`, a lower bound held by a test to never turn away a graph a link
would carry): at tens of thousands of nodes the file is megabytes and blocks the main thread per
toggle, for a size readout about a file that is going to a gist regardless — so it is built on
Upload, and the readout counts nodes and links instead.

### The ⤓ in a card's foot

`ResultDownload`, in `.coda-node__footer` for any card whose result `planExport` can write.
Downloading used to mean wiring a Download node beside it — right for a repeatable pipeline, wrong
for "let me have that table".

**Withheld where the card is already drawing a viewer**, which carries its own ⤓ an inch above and
is the better of the two: it can offer the picture as SVG and PNG, which no amount of looking at the
value can produce. Same rule the `… N more` hint follows when it stands down on a fold.

**The rule bites on the dataset cards, recorded rather than special-cased.** `formatsFor` never comes
back empty for a real value, JSON being the universal fallback — so "any node whose result is
downloadable" is really "every node with a result", and the nine dataset nodes gain a ⤓ writing a
four-line JSON handle. Kept because that file is valid and meaningful: it names the *resolved*
version, the provenance question an unpinned `Latest` leaves open. The narrowing, if it ever reads as
noise, is `defaultFormat(value) !== 'json'` — one predicate, no list — pinned in
`resultDownload.test.tsx`.

**`DownloadButton` is shared, not copied**: the ⤓, its menu, the dismiss and the busy state are one
component behind both `ViewerActions` and `ResultDownload`, the callers differing only in what a
format is called and what picking one does — one asks a live viewer for its picture, the other asks
`planExport` about a value. Same call as `LegendKeys`, extracted from `NetworkLegend`. It carries its
own `.download-button` positioning context, the menu being absolute against it.

### A length is not a count either

`formatCompact` reads magnitude and nothing else, so a cable length of 2,980,158 nm rendered as
**`3M`** — a suffix meaning *million* beside a stored unit meaning *nano*, next to the figure every
paper about a fly neuron quotes in millimetres.

`formatMeasure(value, unit)` (`style/format.ts`) walks nm → µm → mm → m, taking the coarsest rung the
value fills and **flooring at the finest** so a sub-nanometre length does not become `0 µm`:
`2,980,158.182` reads `2.98 mm`, the giant fibre's `22,484,326` reads `22.48 mm`. Four rules:

- **The unit travels with a length and not with a count** — the asymmetry to know before adding a
  fourth unit. Which unit a length wants depends on its magnitude, so `2.98` alone says nothing,
  where `12.9K` beside a `pre` label says everything. `synapses` and `voxels` fall through to
  `formatCompact`: a count has no ladder, and a voxel is not a fraction of anything. Those three are
  the only units declared in the tree.
- **The rung is asked of the *rounded* figure**, which is not a refinement: 999,999 nm fills only µm
  and at two decimals prints there as `1,000 µm` — the separator the ladder exists to remove.
  Promoted only once the rounded figure has climbed, so 999,994 keeps `999.99 µm`.
- **The unit is looked up in the ladder, never tested against `'nm'`.** Gating on the storage unit
  silently drops the unit and reinstates `3M` the moment a column declares µm, mm or m — an uploaded
  CSV, or a source publishing µm. The ladder is **sorted where it is declared** rather than by
  convention, because the search takes the last match: a `cm` added in reading order becomes the
  answer for every length, with no type error and nothing failing for the cases already covered.
- **Glanceable on screen, exact on hover.** The row's title carries the stored figure **verbatim**
  (`cableLength (nm): 2980158.182`), not through `formatNumber`, which groups *and* rounds —
  CATMAID's own 4003103.2328612693 becomes `4,003,103.233`, neither exact nor pasteable, answering
  the one question the hover exists for with a different number. That is `formatExact`,
  `formatCell`'s id branch renamed and exported for the identical reason. The unit sits on the
  **label** rather than after the value, so it survives an absent one.

**The schema half was already right**, which made this a display bug rather than a data one: every
`cableLength` column has carried `'nm'` since `CANONICAL_SCHEMAS`, and Explore Dataset's row *read*
it through `statUnit` — into a `title` and nowhere else. The **Table** viewer is deliberately
untouched, printing exact values with the unit in its header.

**Not covered, and wider than one axis:** every chart that formats a magnitude without seeing the
column's unit still reads `3M` — `scatterDraw`'s axis ticks, the heatmap's colourbar and printed
cells, and both legend ramps (`LegendKeys`, `describeLegend`). The scatter and the legends need the
unit threaded through the plot spec and the encoding resolution, a change to every viewer. The
heatmap is nearer, and instructive about why it is still not a one-liner: `pivotMatrix` copies the
value column's unit into `MatrixValue.valueLabel`, so `Pivot` on a `cableLength` draws `0 – 3M`
beside a caption reading `· nm` today — but a chart states its unit **once**, in that caption, so
scaling the bar means scaling the printed cell values with it and moving the caption to the *display*
unit. Doing only the bar leaves the card disagreeing with itself, which is worse than the number it
fixes.

**`nodes` joined `STATS`** — CATMAID's `size`, a skeleton's node count being what says how much of a
neuron was traced. Without it a CATMAID row had exactly one stat, that backend publishing none of the
other six.

### An identifier is not a quantity

`formatCell` takes the **column name** as well as the value, and a column of identifiers prints
verbatim: `527536`, not `527,536`. A thousands separator is a reading aid for magnitude and an
identifier has none — body 527536 is not five hundred thousand of anything, so the grouped form is a
string no query accepts and under another locale not even the same string, which makes a column
copied out of the table disagree with itself between two machines. The Table viewer's cell `title`
has always been `String(cell)`, so before this the hover and the cell under it disagreed on every id.

**The rule is the name, because nothing in a `DType` can say it** — the gap `BuildNetwork`'s merge
rule documents ("summing added `preId` up to 24093454514") and the one the upload node's
`Text columns` exists for. `isIdentifierColumn` (`core/ids.ts`) reads the name's **last word**,
split on separators and camelCase, covering `neuronId`, `preId`/`postId`, `partnerId`,
`sourceId`/`targetId` and the `root_id` / `pt_root_id` spellings an uploaded CSV arrives under with
no list to keep in step. A plain `endsWith('id')` is a different rule and a wrong one: `centroid` and
`valid` end that way.

**An aggregate of an id column is a quantity again**, excluded by its prefix, derived from
`AGG_OPTIONS` rather than typed out — `groupBy` writes `<agg>_<column>`, so a count of distinct
partners is literally `countDistinct_partnerId`, five figures on male-CNS, and it does want its
separator. The cost is a column somebody else called `max_id` keeping its grouping; taken
deliberately, since `sum_neuronId` is a name Coda generates and `max_id` can only arrive in a file.

**The name is optional and absent means "a quantity"**, which is what every caller did before it
existed. Passed wherever the caller has one — the table cell, the network tooltip and edge label, the
scatter tooltip's label/colour/shape rows, the Neuron Profile and Explore Dataset chips. `Tiles`'
`Facts` takes label/value pairs with no schema behind them and is left alone.

`format.test.ts` pins the rule and `viewers.test.tsx` the wiring, because a cell rendering
`formatCell(cell)` with the name dropped fails no type check and looks exactly like the bug this
fixed.
### Filtering a table, and the port it feeds

Each column header carries a filter field, and what survives leaves by a second output,
**`Filtered`**. `nodes/lib/tableFilter.ts` is the whole of the semantics, headless — the widget
filters its own copy on every keystroke and `evaluate` filters the real one on the committed param;
a second implementation in the UI would draw a row count the port does not honour.

**A cell is the right-hand side of an Explore Dataset field term.** `>=10` under a count means what
`weight>=10` means in the Explore box: same operator table, same null rule (a missing value satisfies
`!=` and nothing else), same comparison semantics, because `resolveFilters` builds real `FieldTerm`s
and hands them to `neuronSearch.ts`'s matcher. That reuse is why `prepareFieldTerms`/`fieldTermsMatch`
were extracted out of `runSearch` — two loops over one matcher, rather than two matchers that part
company on the first null. **Do not re-implement the comparison here.**

**What a cell decides that a query token does not is the meaning of a bare value**, taken from the
column's dtype. On a number `10` is `== 10`; read as a substring it would match 100 and 210, which is
nobody's intent in a synapse count. On text it is a substring, compiled as an *escaped* regex so
`LC4(R)` matches itself rather than being read as a group.

**It does not agree with the Filter node, and that is recorded rather than fixed.** The header *sort*
shares `sortedRowIndices` with the Sort node on a stated rule — collation and null placement must not
differ between a node and a header click. The header *filter* borrows Explore's grammar instead, so
it lands elsewhere on both. Measured: `type == "lc4"` keeps 0 rows in a Filter node (case-sensitive)
and 1 in a header cell; `pre == 0` against a null keeps the null row in a Filter node (`Number(null)`
is 0) and none in a cell. Neither is wrong alone, but a graph can hold both an inch apart, so
`tableFilter.ts` and `filterTable` each name the other. Folding one onto the other decides which
semantics wins and changes what every saved `core.filterTable` returns — not a tidy-up.

**Nothing in it ever throws.** A half-typed cell, an uncompilable regex, a column an upstream edit
removed — none may block the graph, because `out.table` is a tap and a refusal reaches everything
downstream of the *pass-through* too. A clause that cannot be applied is dropped and reported;
`validate` says so on the node and the cell wears `data-invalid`. Note which way that errs: dropping
shows **more** rows than intended, where letting an unresolvable column reach `prepareFieldTerms`
marks it `unknown`, which matches no row — so one stale column name would empty the table and read as
a node that had broken.

**A problem carries its column beside the message, never inside it.** The cell drawing the red border
has to know which column a problem belongs to, and recovering that by substring-matching the prose is
fragile and wrong: `Filter on "pre": "abc" is not a number` quotes the offending *value* too, so a
table with a column called `abc` would see that column marked broken. Same reasoning as
`reportAuthFailure` — matching on message text rots silently. `validate` flattens to strings for the
badge; the viewer indexes by column.

**`filterRowIndices` answers `undefined` for "every row", not an identity array.** The unfiltered case
is the common one and a table here can be the whole of male-CNS, so `Array.from({length}, (_, i) => i)`
is 165,000 elements built and discarded — once per `evaluate` and once per *render*. Both callers
already treat "all rows" specially, so the sentinel costs neither a branch.

**Filtering is data; sorting is still a view.** The two controls sit inches apart and mean opposite
things, so the caption carries both: `5 of 6 rows` for the filter, `sorted view only` for the sort.
Sorting stays out of the provenance key deliberately — a header click is the cheapest gesture anyone
makes on a table, and staling the graph for it would read as a scheduler bug.

**The bill, which is not visible from the port that pays it.** A cache key is one per *node*, so
editing a filter invalidates `out.table` whole and reaches a chain hanging off `Table` as well, whose
bytes did not change; it lands there as `blocked` rather than `stale`. Same trade `out.network`'s
filters make, pinned by `table.test.ts`.

**Draft now, commit in a moment.** Typing filters the drawing immediately and reaches the param
`COMMIT_DELAY_MS` (140ms) after the last keystroke — Explore's split, for Explore's reason: the param
is in the provenance key, so committing per keystroke re-runs everything downstream between two
letters of a cell type.

**Two memos, not one, and the decode is `ValuePreview`'s job.** The sort is keyed on `[table, sort]`
alone: folded in with the filter it re-ran `sortedRowIndices` on every keystroke, which on 165k rows
of a string column is hundreds of milliseconds of `localeCompare` per character. And the clauses are
decoded in a memo keyed on the stored `string[]` — decoded inline they were a fresh array every store
tick, and the viewer resets its draft whenever that identity changes, so it discarded what was being
typed and re-filtered and re-paged on each tick. Same trap `useStable` was extracted for: **memoise
by value.**

**The field lives inside its `<th>`, not in a second row.** `.data-table th` is
`position: sticky; top: 0`, so a second sticky row would need the first one's height as its offset — a
height that varies with whether the column declares a unit. One sticky element that grows cannot
drift. The knock-on is that the column *name* became a `<button>`, which is what sorts; clicking the
field does not. `width: 100%; min-width: 0` on the field stops a filtered column widening as somebody
types.

**The controls are `out.table`'s alone.** `TableViewer` draws every table in the app — a Filter node's
output, a Group By's, an upload's — and only this node has a port for the result, so `ValuePreview`
supplies `filters`/`onFiltersChange` for that one type. Both halves travel together, or there is a
state where the row can be edited and not stored.

**Clauses are stored as JSON pairs, not as a query string.** `parseSearch` reads a field name only
where it matches `FIELD_NAME`, and the columns this viewer draws routinely do not: a wide pivot names
its columns after label values (`LC11_02(R)`) and an uploaded CSV's header can hold a space. Storing
the whole filter as one re-parsed query would lose exactly the columns somebody is most likely to be
filtering. `["Cell Type","~^LC"]` also reads in a `.coda.json` people mail each other, where a
unit-separator join would not.

**The row is toggled from the caption and forced open whenever anything is set**, so an unfiltered
Table card looks as it did before and a filtered one always says why it is short. The toggle is
`disabled` while a filter is live rather than absent — clearing the cells is what closes the row.

**Both exporters emit real filter code**, since `Filtered` has to bind something or downstream
Python/R refers to a variable nothing assigns. Two disagreements had to be written out rather than
inherited: pandas and dplyr are both **case-sensitive** where Coda lowercases both sides and carries
the `i` flag, and `dplyr::filter` **drops `NA`** where a missing value satisfies `!=` here. Every mask
guards `isna`/`is.na` explicitly, including where the operator would have got it right anyway — those
are the ones that break quietly when edited. The fixture carries a **second** Table node for the same
reason it carries two Select One nodes: the first is fed by the Pivot, whose wide schema is observed
rather than inferred, so no clause on it resolves at export time and the golden would record only the
branch that binds `filtered = out`.

**One pre-existing bug surfaced with it.** The overlay's rail draws each param's label itself *and*
passed no `variant` to `ParamField`, whose checkbox draws its own — so a presentational boolean
rendered `Show filter row / Show filter row`. `out.table`'s filter-row toggle is the first boolean to
reach that rail, which is why it had survived: every other param kind ignores `showLabel`. The rail
now passes `variant="inspector"`, as `ParamRows` already did. Exactly the double-label trap
`SelectOneBody` documents.

**Verified in a real browser** as well as headlessly, the header cell's layout being the class jsdom
cannot see: the field sits inside the sticky header (`th` 129–177, field 152–171, first row starting
at 177), column widths do not move as a filter is typed (468/468/481 before and after), the numeric,
regex and invalid cases all behave, and the card shows the row at its own width with the toggle
disabled while filtering. Not covered anywhere: the light theme, and a table wide enough to scroll the
filter row sideways.

### Describe Table: a table about the table

`out.describe` is a tap like every other viewer here, and its second port is the one thing about it
that is not. `out.table`'s `Filtered` and `out.network`'s subset are both *the input, less some of
it*; `Summary` is a different table entirely — one row per **column** of the input, carrying
`non_nulls`, `nulls`, `non_zero`, `unique` and, for numeric columns,
`min`/`q1`/`median`/`q3`/`max`/`mean`. A port rather than only a drawing because "which of my columns
are half empty" has an answer worth keeping: it sorts, joins and exports like any other table.

Three things about it are decisions rather than arithmetic, written down in
`nodes/lib/describeOps.ts`.

**`describeSchema()` takes no arguments.** Every other `*Schema` in the pack is a function of the
input's schema; this one is a constant, because the summary's shape is decided by the statistics and
not by the data. So the `Summary` port is fully typed before anything has run or been wired, and a
picker downstream fills the moment the link is drawn — the opposite end of the range from Pivot,
whose columns are named by its data and which needs `observesOutputSchema` to say anything at all.

**Only numeric columns get numbers, and the id column is not one of them.** A lexicographic minimum
in a column of minima reads exactly like a numeric one and nothing on the row says which it is, so a
`str` or `bool` column reports its counts and leaves the rest null. `neuronId` is `str` on every
source now, which settles it by dtype — but the rule is named rather than inherited, because it was
`i64` on most of them and was still not a quantity: a mean neuron id identifies nothing, and
`CellValue` is a float64 (invariant 8), so on an 18-digit id the arithmetic would not even be over
the ids. An uploaded table can still put numbers in a column of names. Counts survive
that, comparing cells rather than adding them — the same distinction
[`isIdentifierColumn`](#an-identifier-is-not-a-quantity) draws one layer up.

**Absence is `valueLabel`'s, shared with the Dataset Summary rather than restated.** An empty or
whitespace-only string is nothing recorded and `false` is a real answer; neuPrint publishes `null` and
`''` for the same missing annotation depending on the property, so two copies of that rule would let
one node report a column as complete while the summary beside it reports it a third empty.

Two seams easy to get wrong from either end. **The card draws the second port, not the first.**
`ValuePreview` is handed one output value — the primary port's, which on a tap is deliberately the
pass-through — so the default table branch would render a second Table node under a different name.
`describeTable` is called there instead, memoised on the table *object* so it is the same result
`evaluate` already built: without that memo a `cheap` node sorts every numeric column twice per edit,
and the viewer would be handed a fresh frame on every render and reset its page under whoever is
reading it. And **the exporters must not reach for the obvious substitute**: `df.describe()` and
`summary(df)` both look like this node and answer a different question — no distinct count, no
non-zero count, an extra standard deviation, no notion of an empty string being an absence, and in R
a character matrix rather than a frame — so both carry a `coda_describe` helper mirroring the
TypeScript.

## Grouped params — the styling sidebar

`ParamBase.group` and `ParamBase.composite` plus `NodeDefinition.paramGroups` turn a node's flat param
list into a tabbed panel in the expanded viewer. `out.network` and `out.viewer3d` use it; Cytoscape's
Style tab is the reference.

**`out.viewer3d` groups by socket** — Skeletons, Meshes, Points, Volumes, Scene — where the network
groups by half of the drawing. Both are the node's own structure rather than a taxonomy invented for
the panel, which is the test to apply to a third one. Two things came out of it that were not the
point: five tabs do not fit 268px, so `.style-tabs` wraps rather than scrolls (a horizontal scroller
hides the last tab behind a gesture nothing suggests); and a tabbed panel is the shape that carries
the header's `Style` toggle, so grouping a node is also how its controls acquire a way to be *put
away* — the flat rail has none, which is why it is always in the way on the one node whose whole face
is a picture.

**It is opt-in, and the opt-out is the absence of `paramGroups`.** A node declaring no groups keeps
the flat horizontal rail, which is why adding this changed nothing for the heatmap, the bar chart or
the table. `overlay.test.tsx` asserts both halves.

**A composite is a statement about params, not about pixels.** An encoding is three params — a mapping
mode, a column, a constant — because that is what the graph has to *store*; on screen it is one
property with one label. `composite: { key, role }` binds the facets, with `primary` (how the property
is driven), `value` (what by) and `extra` (modifiers like a size range). The two `value` members of a
colour are `visibleIf`-exclusive, which is what lets one slot hold the column picker or the swatch and
never both. It lives on the definition rather than in a UI registry because deriving it from the
`<prefix>ColorMode` naming convention would be string-matching a factory's output, and rots the first
time an encoding is written by hand.

**Nothing is ever dropped.** A param whose `group` names no declared tab, or which has no group at
all, lands in a trailing `Other` tab rather than disappearing — a control that silently vanishes is
far worse than an untidy tab. `groupParams` is pure and tested against the real `out.network`
definition, the load-bearing assertion being that the panel shows *exactly* the set the rail's old
filter produced.

**Composite keys are scoped per tab.** Both the node half and the link half call their row "Label"; a
global key would move one control into the other's tab.

**The sidebar's collapse is `panels.style`, and it defaults open** — unlike the inspector and the
minimap, whose closed default is a canvas argument that does not apply inside a modal nobody opens by
accident. Note the inverted read in `loadPanels`: an absent key means open, so a preference written
before the key existed is not read as the user having closed it. The toggle is in the overlay header,
*outside* the panel it controls, for the same reason the minimap's button is outside the minimap — it
has to survive the thing it hides.

**The panel still shows presentational params only.** That filter is what makes the surface
safe to touch, and it is passed into `groupParams` rather than baked into it — which is the
hook a Filter tab of non-presentational params would come in through, along with something in
the UI admitting that those _do_ stale the graph.

**And `out.network`'s card draws only `Layout`.** Thirty-three params is the largest set in the
registry; fifteen of them showed at once on the default settings, as a column of generic pickers
stacked above the drawing they configure. Everything else is `advanced` now, which is the same
call `out.neuroglancer` and `out.rois` make and is cheaper here than on a smaller node, because
`advanced` is read by the _card_ alone: `paramsForPanel` and `groupParams` never look at it, so
every one of them still reaches the styling panel under the tab it was grouped for, and the
inspector still shows the full set. The `… 24 more` hint is what says so.

Two params are not styling and were still decided the same way. `Layout` stays because it is the
one control that decides what the picture _is_ rather than how it looks — and because a card with
no rows at all loses its `☰` fold and reads as a node with nothing to set, which is exactly what a
viewer this configurable should not be mistaken for. `selection` goes, though it is neither
styling nor layout: its row said `3 nodes · clear`, which the caption already says and clicking
the canvas already does.

Note what pins it. A param added without the flag fails no type check, is not caught by
`paramGroups.test.ts` — which asks about the panel, where `advanced` changes nothing — and simply
appears on the card, so the column starts growing back one param at a time. `network.test.ts`
asserts the card's contents exactly.
