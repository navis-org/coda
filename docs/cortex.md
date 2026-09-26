# Cortex

The Cortex pack, and what it is built on. Its first node is the **Cortex gallery**: an "Explore
Dataset on steroids" that draws many neurons side by side against cortical depth — layer bands
behind them, axon and dendrite in two colours, a stripe per cell for its type — and hands on the
cells picked. MICrONS minnie65 first, through CAVE with a token; built so that other volumes and
light-level reconstructions can join later.

This file is the design record. It starts with what had to be true of the *data* before a gallery
could draw anything (phase A), because most of that was not.

## The plan, and where it stands

- **A — data foundations, in the base.** Done: skeletons keep their compartment labels; minnie65
  has cell typing; a nucleus read places a soma. Each is useful beyond the gallery, which is why
  none of it is in the pack. (A published-release skeleton route was added here too, and removed:
  it drew an older segment under today's id — see *After first use*.)
- **B — the cortical frame, in the pack.** Done: `packs/cortex/frames.ts`, below.
- **C — `cortex:gallery`.** Done. C1 (below): the pack, the node, soma positions, the line-up
  wall. C2 (below): rows and compare modes, a second stripe, order and height, a glyph and a `?`
  document.
- **D — `/cortex`.** Done. The pack is off by default; `coda.science/cortex` switches it on (and
  CAVE with it) through a redirect page and a query parameter, since GitHub Pages never runs the
  main entry at a path it has no file for ([packs.md](packs.md#shortcuts)).
- **F — in the Workflow Wizard.** Done: the gallery is a way of choosing neurons and the laminar
  synapse profile a technique, both gated on a cortical frame (`packs/cortex/wizard.ts`) — the
  first pack to add wizard answers, which is what built the seam ([wizard.md](wizard.md#a-pack-adds-answers)).
- **E — laminar profiles.** Done: `cortex:depth` places any point cloud in the frame and types
  both ends of a synapse; `cortex:laminarProfile` draws a depth column down the cortex against the
  layers. See *Cortical Depth and Laminar Profile*.

Decided with the user: EM cell-type names as published, never a transcriptomic mapping; the rigid
depth transform with the column's layer bounds; proofread cells by default; **a CAVE token is
required** — a token-free route was considered
(a derived index served with the site) and dropped.

## Cell types: one view, as published

MICrONS spreads its typing over about nine tables. The AIBS view **`aibs_cell_info`** applies their
precedence — `cell_type` from the metamodel's corrections, then the non-neuronal column reference,
then the column census, then the volume-wide metamodel; `mtype` from the column m-types, then the
volume-wide predictions — one row per nucleus, 144,120 at v1822. Columns worth having:
`broad_type` (excitatory / inhibitory / nonneuron), `cell_type` (`23P`, `4P`, `5P-IT`, `5P-ET`,
`5P-NP`, `6P-IT`, `6P-CT`, `BC`, `MC`, `BPC`, `NGC`, `6P-U`, `WM-P`, and the glia), `mtype` (22
values, `L2a`…`L6wm`, `PTC`, `DTC`, `STC`, `ITC`), `visual_area`, and the proofreading flags
`dendrite_cleaned`, `axon_cleaned`, `axon_strategy`. It carries a notice that it "is subject to
change"; if it does, the precedence can be rebuilt from the tables named above.

It is minnie65's annotation chain ([datasets.md](datasets.md)), so every node gets the types, not
only the gallery. **No MICrONS table uses transcriptomic subclass names** (IT/ET/Sst/Pvalb/Vip…),
and an EM→transcriptomic mapping (`BC`→Pvalb, `MC`→Sst…) would be Coda's claim rather than a
published one, so there is none. The one published transcriptomic label is
`gamlin_2023_mcs_met_types`: 16 Martinotti cells with a Sst MET-type — relevant to matching, later.

minnie65's neuron table is `proofreading_status_and_strategy`, 2,334 rows: the proofread cells,
2,220 of them with both arbours cleaned and 747 with an axon fully extended or interareal. That is
the gallery's default population by construction.

## Depth and layers

**No table stores a layer per cell**; both come from the soma position.

Depth is `standard_transform`'s rigid minnie65 transform (unchanged since package version 1.0):
scale voxels by (4, 4, 40) nm, rotate +5° about z, move the pia point to y = 0, in µm. (The package
scales its *pia point* by (4, 4, 45) — a slip that changes nothing, the rotation being about z.) For
nanometre input, `depth_µm = (sin 5°·x + cos 5°·y − 396,671.03) / 1000`, checked against the package
on two cells. It is exact near the column and drifts with the cortex's curvature away from it; the
package's streamline field (`minnie_streamline`) is the correction, deliberately not taken for now.

Layer boundaries, µm below pia, from Allen's `cortical-layers` classifier at the column — the only
published source with an L6a/L6b split, and the one the column's own labelled cells agree with
(23P from 60 µm, 4P 250–383, 5P 347–580, 6P 501–726, WM-P 726–760):

| boundary | depth |
| --- | ---: |
| L1 / L2/3 | 57.6 |
| L2/3 / L4 | 226.4 |
| L4 / L5 | 361.3 |
| L5 / L6a | 501.6 |
| L6a / L6b | 678.1 |
| L6 / WM | 716.6 |

A second published set (the dash connectivity viewer) sits about 50 µm deeper at four of five
boundaries, in a frame that could not be identified; it is not used.

### As declared: `packs/cortex/frames.ts`

`CORTICAL_FRAMES`, one per dataset, **data rather than code**: a rigid depth (the rotation about
z, and the pia point that becomes depth 0 — declared as the point, not the 396,671 nm offset it
produces, so what is written is what can be checked against the package's source), the layers as
**bands named by where they start**, the last (white matter) running on, and an allowance above the
pia.

- **Keyed on the dataset id, not the family.** A frame is a fact about coordinates, and a Dataset
  value carries a source and a dataset id and never a family key — from a shipped family and from a
  Custom CAVE node alike. So a frame is a `DatasetBinding` (`cave` + `minnie65_public`, version
  dropped) matched by `bindingFor`, the same match `spaceForDataset` makes for template spaces,
  lifted out of it rather than copied.
- **`projector(frame)` works its constants out once** — the trigonometry, the pia term, the µm
  conversion folded in — and projects a point or a flat xyz buffer (`SkeletonGeometry.positions`)
  into lateral, depth and z. Per point with the constants recomputed and an object allocated was
  measured at up to 13 times the cost, which is the gallery's hot path: every vertex of hundreds of
  skeletons.
- **`layerOf` reads above the pia as L1 only within the frame's allowance** (40 µm on minnie65,
  the measured −31 padded). A position in voxels, or from another volume, lands hundreds of
  micrometres above and gets **no layer** — reading it as L1 would draw a clean, plausible column of
  wrong layers.

The test's expected numbers are `standard_transform` 2.0.0 run on four points and written out —
never re-derived in the test, which would check the formula against itself. The first is the pia
point, whose lateral position is what pins the rotation's sign. The sweep walks the frames, not the
families, so a frame bound to a misspelt dataset fails.

**What this shape will not hold yet**, and the light-level data is where it bites: a frame per
*cell* rather than per volume. Sorensen's layer-aligned SWCs share Allen's average VISp bands, which
fit, but Scala's M1 cells each carry their own slice's cortical thickness and have no L4 — a
normalised depth per cell, not a transform per volume. That is a second kind of frame, added when
that data is.

## Axon and dendrite: labels are the source's, never inferred

`SkeletonGeometry.compartments` is SWC's structure codes per point — 1 soma, 2 axon, 3 basal and 4
apical dendrite, 0 unlabelled — and **absent where the source labels nothing**, which is most
sources. It is filled by minnie65's skeleton service and by any SWC file whose `type` column says
something ([backends.md](backends.md#a-geometry-is-the-id-asked-for--why-there-is-no-swc-release-route)).

Three things to know before drawing with it:

- **`out.topology`'s codes are a different vocabulary** — 0 unassigned, 1 dendrite, 2 axon, 3 linker,
  computed by synapse flow centrality. The two must not be mixed: one is a measurement the source
  published, the other a result Coda computed.
- **The service labels an axon on every cell**, proofread or not, by an automatic split; only
  `axon_cleaned` cells' axons are proofread ones, which is what the gallery's default `Proofread`
  level keeps.
- **Clean Skeletons carries them** on the index maps its radii already ride — unchanged through
  heal and smooth, `keep` through downsampling, and the **nearer end** of a resampled node's edge
  (a code is a category, so it is not blended). A first version dropped them with a warning, which
  on minnie65 threw away on every Run the thing the gallery draws. `pnpm probe:skeletons` asserts it on real Pyodide, by position: resampling emits the
  root and then walks back from the tip, so an order-based check fails on correct labels.
  Everything else that moves a skeleton (mirror, transform) spreads the item and keeps them.
- **One rule for a code, where the byte is written.** `compartmentCode` rounds and clamps,
  `labelledOrNone` drops an all-zero array; both live in `data/skeletonTree.ts` and are applied by
  the two walks that allocate the array — a `Uint8Array` would otherwise wrap an out-of-range value
  in silence.

## The gallery (C1)

`packs/cortex/gallery.ts` (the node), `cells.ts` (the table and the wall's sample),
`ui/cortex/GalleryBody.tsx` (the card), `wall.ts` (projection, packing, drawing). Verified in a
browser against live minnie65 (materialization 1822): 68 of the 2,220 doubly-proofread cells
across 14 types drawn, card and full size; a picked NGC came out of `Selected` at 22 µm, L1, and
out of `Skeletons` with its labels.

- **The Cortex pack is the first off by default** (`defaultOn: false`, `requires: ['cave']`). That
  broke three tests that built a switched-off set by hand, which is the lesson worth keeping: a
  reader's set starts from `packsOffByDefault()`, and a test standing in for one must too. The node
  browser's layout tests switch Cortex on instead, being about layout and counting the registry.
- **Explore's split.** The node is `expensive`; the wall is live. Filters, the per-type sample and
  its seed are `presentational` — browsing re-runs nothing — and only `selection` reaches the
  outputs. `ownControls` stops the full-size view drawing those params a second time as a rail
  above the body's own controls (`internal` was the wrong flag: it hides from the inspector and
  leaves the rail).
- **A soma is a source capability** (`DataSource.somaPositions`), answered on CAVE from the
  datastack's declared nucleus table through `cave/nuclei.ts`, memoised for the session. Asked in nanometres; the server answers `pt_position` as
  three split columns, and asking for the split names by hand is a 500 (checked live).
- **The wall's sample is per type, seeded per type** (`seededRandom`, now shared with Sample and
  the centrality sweep rather than copied a third time), so filtering one type out redraws no
  other's. Groups run in order of median soma depth, so the wall reads down the cortex.
- **The wall asks for one cell per request, on Automatic**, so each cell draws as it lands rather
  than when the slowest of a batch does, and one cell being one value, Automatic's all-or-nothing
  rule never mixes anything. Requests are cancelled when the wall moves on, arrivals render once
  per frame, what is held is pruned to what is shown, and the first failure is said once rather
  than drawn as silent gaps.
- **Every cell is placed absolutely** (`layoutWall`) and keyed by id. Laid out as a row element per
  row, a cell moving row when an earlier one's skeleton landed and widened it was an unmount, a
  fresh canvas and a redraw of every segment — for every later cell, on every arrival.
- **A cell is as wide as twice its farther reach from the soma**, being drawn centred on it; sized
  by its whole span, a lopsided arbour was clipped on its long side. Where no point is labelled
  soma, the root is.
- **Grouped by a column** (`groupBy`, default `type`, resolved through the context) rather than the
  literal `type`, and **coloured by `resolveColor`'s categorical rule over the whole table**, so a
  stripe is the colour every Scatter, Network and 3D view gives the same value, commonest first,
  and a filter recolours nothing.
- **The proofreading columns are the frame's declaration** (`CorticalFrame.proofreading`), not
  names the pack knows. Where the table lacks them — minnie65 without its annotation chain — the
  card says so and shows every cell; filtering to nothing read as a dataset with no neurons.
- **The dataset input is `useDatasetInput`**, shared with Explore, where the three rules for reading
  it (value over type, the chain off the value, wait while a wired chain has not run) are written
  once.
- **Drawn per cell on a canvas**, projected once per skeleton (`cellGeometry`, a `WeakMap`), rows
  packed to the measured width. The layer bands are **one canvas per row** under the cells, the
  ruler's labels at its left, and a cell's canvas is its arbour's own width centred in its button:
  a justified row reflowing as a neighbour lands is then a style, where a canvas the button's width
  redrew every later cell on every arrival. The bands are the grid ink —
  chrome, under the contrast floor by design — so they read as ground. Axon and dendrite are
  `axonDendriteInk`, shared with Topology so the two never disagree on which colour is the axon; an
  unlabelled segment draws neutral rather than guessed. Type stripes cycle, and **say so** ("type
  colours repeat") past eight types, as every cycling encoding here must.
- **A canvas font does not resolve CSS variables**: `canvasFont` reads `--font-ui` off the
  document, as the flow chart's measurer does.
- A probe trap worth knowing: after a hot reload the app imports modules with a `?t=` query, so a
  probe's `import('/src/store/graphStore.ts')` gets a **second store** — graph loaded, canvas empty.
  Import the URL the page itself loaded.

## The gallery (C2)

Verified in a browser against live minnie65 at full size: fourteen labelled row sections at the
left edge; 23P beside BC in compare, one depth scale, the right half starting at the column
boundary; a second stripe on every cell from `mtype`, with its legend and "colours repeat"; a pick
landing in `selection`; the document never wider than the window.

- **Three modes, one layout.** `layoutWall` takes *columns of sections*, and `wallColumns` turns a
  mode into them: line-up is one column of one section, rows one column with a section per group,
  compare two columns of one section each.
  Each section starts a row of its own with its label over it, and every row keeps its ruler, so
  a depth is readable wherever the eye lands. Compare is two groups side by side, as decided with
  the user.
- **Compare asks `wallGroups` for every group**, whatever the chips say, and names its two by
  label (`compareA`/`compareB`, plain strings). `compareGroups` (in `cells.ts`, tested headless)
  falls an empty or vanished name to the first group and then the next, so a new card compares
  something rather than nothing. The chips are hidden there, being a filter over groups compare
  does not read; `Order` stands down by its `visibleIf`, there being no sequence to order. Plain
  strings rather than enums because their options are the table's groups, which an enum's
  `options(ctx)` cannot reach.
- **The second stripe is a column picker, not a fixed `mtype`**, coloured by the same
  whole-table `resolveColor` as the first, and keyed in the legend with its column named — the
  first stripe's key is the chips. "Colours repeat" is said once for either.
- **Order is a group order only**; within a group cells stay shallowest first. `shuffled` sorts by
  the per-group seed. **`seedFor` had to be mixed**: as a bare polynomial hash the seed contributes
  the same `seed·31ⁿ` to every label of length *n*, so comparing two labels' hashes cancelled it
  and every seed gave one order — found by the order test, invisible on a wall. The mix is
  `core/hash.ts`' `fmix32`, which the neuroglancer shard hash now calls too rather than holding a
  copy. It also changes which cells a given seed samples, which nothing stores.
- **Height is full-size only**; the card stays a 130px strip.
- **The controls are the node's params drawn by `ParamField`**, read off the definition through
  `visibleParams`, as every other card body draws its own. A first version had a private `<select>`
  and exported the option lists for it — a second spelling of each label and bound, and a select
  that renders a stored value missing from its list as the first option.
- **The second stripe's key is `ColorKey`**, the one every viewer's legend draws. A hand-built copy
  dropped `+N more`, so an `mtype` key cut at its twelfth value read as a column with twelve values;
  `colours repeat` stays the gallery's own line, as it is each viewer's caption.
- **A probe trap:** an optional column picker with *no stored key* reads as off
  (`columnAbsence`), not as its declared default — `defaultParams` writes the default at
  creation. A probe that loads a graph with `params: {}` therefore gets a wall with every cell in
  one "untyped" group and reads as a grouping bug. Build nodes through `addNode`, or write the
  default.

## After first use

Six reports from the first person to use it, each a thing no probe had asked.

- **A bare Dataset showed no cell types.** Every probe had built minnie65's annotation chain in
  front of the dataset; the help page's own figure, and a dataset dropped from the palette, do
  not — and minnie65 keeps both its typing and its proofreading flags off the neuron table. The
  card then said the cells "carry no `dendrite_cleaned`, `axon_cleaned` — wire the dataset's
  cell-type table", which names columns rather than a remedy. The fix, chosen with the user, is
  a **`Cell types` dropdown**: the gallery reads the chosen table itself (`cellTypes.ts`), for the
  card and for `evaluate` alike, and joins it onto whatever the Dataset carries.
  - **The options are declared, not listed off the datastack** (`CorticalFrame.cellTypes`).
    minnie65 lists 53 tables and views, most of them synapses, coregistrations and spine
    predictions; eight are typings, every one read live and arriving one row per neuron with a
    `type` column (`live.test.ts` holds that). The first is `aibs_cell_info`, and
    `frames.test.ts` pins it to the family's annotation chain, so the gallery and every node
    behind that chain agree on what a cell's type is.
  - **The default is `''`, not the table's name**, so a saved graph follows the frame if its
    first choice is ever revised; a name the frame no longer lists is still read, keeping every
    column, rather than becoming the default in silence. **None** reads only what the Dataset
    carries, for somebody's own table wired in.
  - **Proofreading is its own read** (`CorticalFrame.proofreading.table`), made whichever typing
    is chosen — otherwise switching to the m-types would switch the filter off. Where the two are
    one table it is one read.
  - **Not presentational**: the chosen table's columns are what `Selected` carries, so the pickers'
    schema (`schemaFrom` with params), inference and `evaluate` all go through `cellTypeRefs`.
- **The expanded view clipped after two rows and did not scroll**, and the card cut at one row by
  a count. The wall is now a scroll area in both (`.gallery__scroll`, with `scrollbar-gutter:
  stable` so a scrollbar arriving cannot narrow the rows that made it necessary and re-pack them).
- **Rows are justified**: every row but a section's last shares its unused width evenly, in whole
  pixels (`layoutWall`, a placed cell's `width`). The arbour stays centred at the depth scale, so the
  extra is margin, never a stretch; the last row keeps its own widths, as justified text does.
- **The card resizes** through `NodeBodyEntry.resizable` — the viewer's resize path, opened to a
  body that asks, with the body absorbing the height the way a viewer's preview does. Not a
  change of category: `visualisation` also decides previews, the dock and the dashboard.
- **Proofread cells drew without their axons — because the skeleton was of a different
  segment.** The v661 SWC release led Automatic, reached by mapping today's root id through its
  nucleus to the root it had at 661. `864691136314078013` came back 2.9 mm of dendrite; the id's
  own segment is 22.9 mm with a proofread axon. Over 40 doubly-proofread cells: 23 without an axon
  in the release, median 49% of the current cable. **The rule, the user's: a geometry is the
  morphology of exactly the id asked for — never an id mapped to another timepoint.** The route is
  removed, and the root-lookup batching it needed with it
  ([backends.md](backends.md#a-geometry-is-the-id-asked-for--why-there-is-no-swc-release-route)).

- **The card drew at CSS resolution on a zoomed canvas.** React Flow magnifies a card by a
  transform, so a backing store sized for CSS pixels × device ratio was stretched — 110 px shown
  at 161 at the canvas's loaded zoom of 1.47, reading as low resolution. `prepareCanvas` takes a
  further scale, read from `useCanvasScale()` (`ui/viewers/canvasScale.tsx`): a context
  `CodaNodeView` provides around a card's body (`CardCanvasScale`, the one place React Flow's
  store is asked), 1 everywhere else, rounded up to half-powers of two, never below 1. Shared
  rather than the gallery's own so the heatmap's and scatter's card canvases, which blur the
  same way, need only call it. **Capped at a total
  ratio of 3**, because every cell on a card's wall has a canvas mounted whether scrolled into view
  or not and memory grows with the square: sharp at ordinary zooms, soft again past about 1.5× on a
  2× display. Lifting that means drawing only the rows in view at the high ratio.
  **The step follows the zoom only once it settles** (`SETTLE_MS`, 200 ms, through a store
  subscription rather than a selector). Following it live made a pinch over the card jittery:
  each step resizes and redraws every cell canvas at once, ~20–30 ms for 70 cells of 8,000
  segments in headless Chrome, and a pinch hovering at a boundary crossed it back and forth.
  During the gesture the transform stretches the old backing store; it sharpens once, after.

- **The wall downloads as SVG and PNG** through the viewers' own `ViewerActions` — a body had no
  export at all, only `out.*` viewers did. `wallToSvg` (`ui/cortex/wallSvg.ts`) synthesises the
  document as `heatmapToSvg` does, and places everything through the canvas's own geometry:
  `layoutWall`'s placements, and `layerBands`, `cellMapping`, `cellInks`, factored out of
  `drawBands`/`drawCell` for it, so the figure is the wall rather than a second drawing. It draws
  **every row**, not the ones scrolled into view, and not the selection, which is card state. The
  legend replaces the chips a figure has no room for: axon and dendrite, the drawn groups under
  the grouping column, the second stripe's key with `+N more`, `colours repeat`. Measured on a
  68-cell minnie65 wall: **6.4 MB of SVG** (a branch is one run of `L`s, coordinates to a tenth
  of a pixel; vectors are the cost) and a 2990 × 5840 PNG of 1.8 MB. The font travels as a
  `<style>` from `uiFontFamily`, a detached document resolving no CSS variable.

- **Column widths are decided in µm, and chosen.** A cell's width was its extent clamped between
  28 and 200 *pixels* — so the clamp sat at ~630 µm on the card (0.16 px/µm) and ~270 µm full size
  (0.37 px/µm): the card showed every arbour whole and uneven, the full view clipped the wide ones
  and looked even, with nothing on screen to say why. `columnWidths` now decides in µm and only
  then scales, so the two views agree (measured: every one of 68 cells 2.28–2.33× wider full size,
  the scale ratio being 2.31; exactly 2.30 in even mode). **A canvas is its arbour's own width in
  either mode** and an even column clips it (`overflow: hidden`; the export clips the same way), so
  an automatic width stepping as the wall fills changes the layout and redraws no arbour — sized to
  the column, every landed cell redrew at each step. The width is typed as `columnUm` and read by
  `readColumnWidths` (`cells.ts`, on the heatmap's `readLimit`), which `validate` also reads, so an
  unreadable width is said on the card rather than silently ignored. The `Column width` param is the choice
  the accident was making: **Fit** (the default, chosen with the user) — each cell its own extent,
  never clipped — or **Even**, one width for all, the arbour clipped. Even's width is `Width (µm)`,
  a string param because unset means **automatic**: the median extent of the cells landed, rounded
  up to 50 µm, so a filling wall re-lays itself out at a few steps rather than on every arrival,
  and loading cells take the even width at once. A 150 µm floor keeps a loading or tiny cell a
  clickable column in fit mode.

## Cortical Depth and Laminar Profile

Two nodes that make the frame reachable from the rest of the canvas, chosen with the user as the
first step past the gallery: a laminar input profile, split by partner type.

- **`cortex:depth` places points, not cells.** It adds `depth` (`POINT_DEPTH_COLUMN`; the
  gallery's is `soma_depth`), `lateral` and `layer` to any
  point cloud through `placeAll` (`frames.ts`), the one walk `cellsTable` now takes too — so a soma
  and a synapse at one place cannot come out at two depths (`pointDepth.test.ts` holds them to a
  nanometre, the cloud's positions being float32). Two outputs, the cloud and its attributes as a
  table, because a point cloud reaches the 3D View and no chart.
- **Types are a lookup per end, never a join.** A synapse row carries `neuronId` and `partnerId`;
  the chosen typing (the gallery's `Cell type source`, now `cellTypeSourceParam`, one declaration)
  is read once, keyed through `displayLabels` (the shared reader: first row per id wins), and looked
  up for both, filling `type` and `partnerType`. The read is
  `cellTypeRefs(…, { proofreading: false })`: the flags' own table is skipped, but where one table
  carries both the union is kept, so it stays the cache entry the gallery and the annotation chain
  share. **`expensive` because of that read**, not the arithmetic — a `cheap` node runs on being
  wired, and upstream is a Synapses fetch that needs a Run anyway.
- **Measured on minnie65** (864691136314078013, a neurogliaform cell): 5,891 input synapses, 43% in
  L1 and 57% in L2/3, placed and typed in 3.5 s, nearly all of it the first read of
  `aibs_cell_info`. **95% of partners are untyped** — fragments and unproofread segments — which is
  what shaped the viewer.
- **`cortex:laminarProfile` is a Histogram turned down the cortex**, and the binning is the
  Histogram's (`binScan`) with two options added rather than a second binner: `width`, edges at
  multiples of the bin so a bar starts at a round depth; and `missingLast`, which takes the
  no-value series out of the colour ranking and stacks it last in muted ink. Without the second,
  the untyped 95% took the first hue and every typed partner was a sliver at the far end of its
  bar. The layers need the Dataset wired — the frame is a fact about a dataset and a table carries
  none — read off the wire's *type*, so they draw with the first result.
- **A layer's count is a selection too**, stored as the layer's depth range from `layerRanges`
  (`frames.ts`), the one statement of the bounds that `layerOf` also reads (the first layer
  reaching up to the allowance; the deepest ending at a stand-in 1 m, since a stored range must be
  finite). `laminarProfile.test.ts` holds that clicking a count
  selects exactly the rows it counted.
- **`niceTicks` stopped within half a step of the maximum**, so its last tick — which three
  charts take as the axis end — could fall short of the longest bar: a histogram peaking at 120
  drew its tallest bar a fifth past the plot. Seen on this viewer in a browser, and fixed at the
  helper (`format.ts`): ticks now run to the first at or past the maximum.
- **The demo builder picks a viewer by two rules** (`demo.ts`, `addViewer`). It took the first
  viewer that accepted the type, and Laminar Profile — any table, registered first with its pack —
  ended the demo of every table-producing node with its Depth picker substituted onto `size`: 24
  new warnings against `demo.test.ts`' ceiling. First, **only what a fresh session offers**, plus
  the node's own pack: calling the registry directly ignores the pack switches (the rule in
  CLAUDE.md), which is the actual cause. Second, **the first that raises no issue of its own**,
  else the first at all. The second alone was not enough: before a table's schema arrives a picker
  on its declared default raises nothing, and seven demos (Google Sheet, Upload Table…) still ended
  on Laminar Profile. The check's inference is handed on to the scorer rather than run twice.

- **Faceting is small multiples on one picture.** `Facet by` (`type`, or `neuronId` for a panel
  per neuron) gives each value a panel — one depth axis, one bin grid, one count scale — and **one
  series ranking over the whole table** (`seriesFold`, passed to each panel's `binScan` as `fold`):
  ranked per panel, a partner type changed colour from one neuron to the next. `percent` is per
  panel, which is the point of it. Panels are largest first, capped by `Panels`, the no-value
  panel last (faceted by `partnerType`, the untyped panel would open the chart). A faceted panel
  names each layer and its share inside its own right edge: at the left, the first panel's bars
  covered the names — seen in a browser.
- **A faceted selection names its column**, `lo:hi|column|label` (`profileSelection.ts`). A bar in
  a panel is "these depths within this facet", so a bare range would have selected them in every
  panel; and with the column in the entry, `evaluate` never reads `Facet by`, which is therefore
  presentational — in the full view's rail, and regrouping re-runs nothing. The first cut read the
  param in `evaluate`, which kept it out of the rail (the rail shows presentational params only).
  Two consequences, both deliberate: an entry whose column has gone upstream **selects nothing**
  (`rowsWithLabels`' rule — matching every row at those depths would widen a panel's bar into the
  population), and an entry made under another grouping still selects its rows but draws in no
  panel, so the caption counts it (`N not in these panels`) rather than every bar dimming with
  nothing lit. `chartSelection.ts`' header names this as the one way out of its rule.
- **Faceted, one decision each, taken once.** The bin width is decided over the whole table
  (`alignedWidth`, the doubling past `MAX_BINS` that each panel used to decide for itself), and
  panels and series rank through one `foldByRank` (`facetGroups`, `seriesFold`). The panels are
  memoised apart from the hover — a pointer move draws one highlight over them — and the grouping,
  each facet's scan (cached by label, so raising `Panels` scans only the new ones), the layer counts
  and the bins are memoised on what each actually reads.

- **Two shared hooks were fixed at their root, found through this viewer.** `useElementSize`
  observed once, on mount, so a chart whose first render was its empty state — every chart viewer
  returns that before the measured box — stayed blank once it had something to draw, until
  remounted; it now observes whichever element is under the ref after every commit
  (`laminarProfileViewer.test.tsx` rerenders from empty to drawable, and fails on the old hook).
  And `useMarkSelection` took the host's inline `onSelectionChange` as a dependency, so its object
  was new on every render of the card — every graph edit, every drag frame — and a viewer memoising
  its marks on it redrew them all; the callback is read through a ref now.

## What is deferred, and why

- **A CAVE workflow on "latest" refuses its first Run.** Found making the changelog's MICrONS
  example: the wizard leaves minnie65's version on latest, the version list has not arrived when a
  run starts, and every reader wired to the Dataset by reference is refused with *Run again once it
  has* — `Scheduler.gatherInputs` reads the run's inference once, before the listing lands. A second
  Run works. The curated Laminar Profile example (`wizard/curated.ts`) pins 1822 for that reason,
  and so must any curated example on a published dataset; the general fix is a
  scheduler change — await the listing for a cold "latest" dataset in scope before inferring a full
  run (runs may fetch; invariant 2 binds inference) — and would retire the pin.

- **V1DD** is served from `globalv1.em.brain.allentech.org`, behind an Allen sign-in Coda has no
  credential for; nothing was scanned.
- **Light-level reconstructions** (Gouwens 2020, Scala 2021, Sorensen 2026) are on the Brain Image
  Library, which answers with four separate `Access-Control-Allow-Origin` headers, none of them
  Coda's — a browser cannot read them, so they need a mirror. Sorensen's `_LayerAligned` SWCs are
  pia at 0 with axon, basal and apical labelled; Allen's average VISp layer depths
  (`mouse_me_and_met_avg_layer_depths.json`: L2/3 115.1, L4 333.5, L5 453.6, L6a 687.7, L6b 883.1,
  WM 922.6 µm) would be that frame's bounds. M1 (Scala) has no L4.
- The inspiring app's **Similarity** and **Matches** tabs.
