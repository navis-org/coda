# Viewers: charts

The plotting viewers: Scatter, the histogram/pie/box family, the Rank Plot and the Line Chart.
[viewers.md](viewers.md) holds what every viewer shares — export, tooltips, table filtering and the
styling sidebar.

## Scatter plot

`out.scatter`, `Add ▸ Visualisation ▸ Scatter Plot`. seaborn's `scatterplot` — x, y and the
three encoding channels hue, size and style — plus what this data needs on top: log axes, a
linear fit, and a lasso that hands the enclosed neurons back to the graph. `Table → Scatter`
passes the table through and emits `Selected`, so it is a tap like every other viewer here.

**Canvas rather than SVG, and that follows from what it is for.** The `Embedding` node in the
TODO list feeds this one, and an embedding is of a _whole dataset_ — male-CNS is 165,122
traced neurons. One `<circle>` per row is a hundred and sixty thousand DOM elements. Export
re-draws the same spec as vector (`scatterDraw.ts`), so what is given up is the DOM and not
the vector file. Same doctrine as `networkToSvg`, arrived at from the same constraint.

**Everything geometric is in `scatterPlot.ts`, headless, and that is not tidiness.** jsdom has
no canvas, so anything left in `ScatterViewer.tsx` is covered by nothing at all — the same
standing `networkLayout.ts` and `networkDraw.ts` have. Scales, ticks, the point budget,
projection, hit testing, lasso containment and the least-squares fit all live there.

**Two coordinate spaces, and mixing them is the trap.** _Value space_ is what is in the
column and what a tooltip prints; _transformed space_ is that under the axis scale, i.e.
`log10(value)` on a log axis. Domains, ticks, the viewport and the trend fit are all
transformed, because that is the space the picture is linear in. `forward`/`inverse` are the
only crossings and everything named `*T` is transformed.

**Every row is drawn, and past `CIRCLES_MAX` (10,000) visible marks they are drawn on the GPU.**
There was a `Max points`, a deterministic stride of 50,000, and it existed because a path of
antialiased circles is Skia's raster at ~3.4 µs a mark. Measured by `pnpm probe:scatter-scale` on
fish2's 129,325-neuron NBLAST embedding (M3 Max, devicePixelRatio 2, median frame while panning):
10,000 circles 16.7 ms, 50,000 117 ms — so the old default was not smooth either — and 129,325
420 ms. Issuing the path took 21 ms of that and the spec 3.4 ms; the rest was raster, worse on a card
where marks overlap more. Nothing was culled, so a tenfold zoom with 4,261 marks in view still took
50 ms. Now `buildScatter` culls to `spec.visible`, which the canvas pass, the hit index and the
export all walk, and the count of it picks the pass: paths up to `CIRCLES_MAX`, pixels above.

**The pixel pass is one WebGL2 context for the whole app (`scatterGl.ts`), with a CPU raster
(`scatterRaster.ts`) as its fallback and as the export path — and the CPU raster was the first
answer and was wrong.** A prototype stamping pixels into an `ImageData` measured 60 Hz at 129,325
and was recommended on that number; it had stamped marks of ~2 device pixels where a real one is 6,
five times less work. Built properly it took 103 ms a frame. Blending onto an *opaque* buffer — the
plot background and grid written in first, so source-over needs no division and red and blue share
one integer multiply — brought it to 67 ms at 2× and 18 ms at 1×, and that is the floor: the cost is
the overdraw itself, 129,325 marks of ~113 device pixels over a 3.5M-pixel plot. `gl.POINTS` drew
the same frame in 6.7 ms of main thread. **One context, not one per scatter**: the module owns an
offscreen canvas, draws whichever scatter is repainting, and that scatter copies the frame into its
own 2D canvas with `drawImage` *in the same task*, which is why `preserveDrawingBuffer` is off. The
2D canvas keeps the background, grid, axes, trend and hover; only the marks and the selection rings
go through the GPU. Every other WebGL user here is a viewer owning its own context, which the store
and the dashboard ration carefully, so a scatter on every card would have been one more each.

**A pan builds a frame of the marks, never the marks.** `ScatterMarks` (`buildMarks`) is
everything a pan cannot change — the usable rows, each mark's coordinates *in transformed space*,
its radius, colour and shape, the colour/shape buckets, the trend fits — and `ScatterSpec`
(`buildScatter`) is one frame of it: the view, the ticks, `px`/`py` and `visible`. The viewer
memoises them separately, so a pointer move during a pan projects stored numbers and does nothing
else per mark. Before the split every frame re-read every cell through `cellNumber`, re-resolved
every encoding, allocated two `Array(n)` of colours and shapes, rebuilt the hit grid, rebuilt a
string key per row to find the selection, and re-uploaded ~2.5 MB to the GPU. Measured at
129,325 marks on the GPU path (median per frame): building the frame 3.6 → 0.4 ms, the hit index
1.1 → 0 ms, issuing the draw 2.9 → 0.1 ms; the marks cost 3–10 ms once. Four things follow:

- **The GPU keeps the marks uploaded and moves a uniform.** Positions go up once as transformed
  coordinates *less the data's centre*, and the vertex shader applies `viewAffine`'s scale and
  offset — the one definition of the projection, which `projectX`/`projectY` and every frame also
  read, so the shader holds no projection of its own to drift. Opacity is a uniform too, so neither
  a pan nor an opacity drag uploads anything, and the trend's ink is the frame's, so a theme change
  does not rebuild the marks either. The centring is not optional: float32 absolute positions would lose the low
  digits of large values under a narrow view, and the probe draws the parity mark again with every
  coordinate offset by 10,000,000 and gets the identical footprint. Uploads are kept per marks
  object, eight at most (`MARKS_KEPT`), least recently drawn deleted — a dashboard repaints
  several scatters in turn, and a `WebGLBuffer` is only freed when somebody says so. The lookup is
  a `WeakMap`, so the eight uploads do not pin eight sets of ~6 MB of arrays after their viewers
  let go; `LruMap` holds keys strongly and has no eviction hook, which is why it is not used. The GPU draws
  the whole set and clips; culling to `visible` is a CPU concern, where `CIRCLES_MAX` is counted.
- **Selection indices are positions in the marks**, so the `selectedIndices` memo keys on the marks
  and the selection, and survives every pan.
- **The hit index is built on its first query.** A pan makes a spec per pointer move and hovers
  none of them, so an eager grid was a hundred thousand entries built and discarded per frame.
- **Stacking order is the marks'**: `markBuckets` runs once over every mark, recording each mark's
  bucket, and `visibleBuckets` sorts a frame's visible marks into those buckets in one pass over
  `visible` — so it costs what is on screen, and keeps the order — so the GPU pass (all marks) and the circle path
  and CPU raster (visible marks) stack categories identically.

`scatterRebuild.test.tsx` drives a real pointer pan and asserts frames are rebuilt and the marks are
not; the rest is `pnpm probe:scatter-scale`.

**Crossing the threshold must not change the picture**, so three things are shared rather than
matched. *Stacking*: `markBuckets` is the one batching, its order the draw order in all three
painters — the path pass used to bucket by a `colour|shape` string per mark per frame, and a second
batching would stack categories differently either side of 10,000. *Composite*: premultiplied
source-over at the node's `Opacity`, which is what `globalAlpha` does to a path; last-write-wins was
faster and discarded `Opacity`. *Shape*: `markStamp`'s coverage (a 4×4 supersample per shape and
size) is what the CPU raster stamps and what the GPU's texture array is built from, so an outline
has one definition. The probe draws one isolated mark with its selection ring either side of the
threshold and compares: same centre colour, footprint 100.3% of the path's. The selection ring on
the GPU is analytic, its radius depending on the mark's.

**The export carries the plot area as one PNG past the same threshold**, axes, ticks, labels and
legend staying vector — matplotlib's `rasterized=True`. Measured at 129,325: 2.8 MB in 359 ms, against
5.7 MB of vector marks. `Vector marks` opts back in. The image is the CPU raster at 4×, opaque, so it
carries the grid drawn into it over the vector grid beneath; where the browser cannot encode a PNG,
the export falls back to vector marks rather than to none. `Vector marks` is presentational for the
reason everything on the tabbed panel is: no output can tell.

Two smaller findings from the same work. The hit index used to bucket every mark, and `cellOf`
clamps off-plot positions to the border cells, so a zoom into one cluster piled the rest of a
whole-dataset embedding along the edges and a hover there walked it — it indexes `visible` now. And
a stored `maxPoints` is simply an undeclared param, which `normalizeParams` ignores; it was
presentational, so no provenance key moved.

**Selection is by id, with the row index as an admitted fallback.** `nodes/lib/rowIds.ts` owns
it and _both_ the viewer and the node import it — what a selected point is called has to mean
the same thing to the code writing the ids and the code resolving them, and two agreeing
implementations drift the first time either is touched. `idColumn` defaults to `neuronId`
through `optional: true`, which is what makes the resolver answer "nothing" rather than
reaching for the first column when the table has none. The fallback exists because the tables
least likely to carry an id — an uploaded CSV of embeddings, a `groupBy` roll-up — are exactly
the ones a scatter is for, and a dead lasso there is worse than a fragile selection the caption
labels `by row index`.

`idColumn` is therefore **not presentational**, alongside `selection`. It decides which rows
`Selected` carries; marking it presentational would let a stale downstream result survive a
change to the very thing identifying the rows. Those two are also the only params outside the
tabbed panel, which is what keeps every tab's presentational-only promise true without an
`affectsData` warning anywhere.

**Reading a cell refuses what `Number()` accepts.** `Number(null)` and `Number('')` are both
0, so a plain conversion draws a dense stripe of data that does not exist along each axis.
Same trap `numeric()` in `encoding.ts` exists for, same answer. Rows that cannot be placed are
**counted and reported** (`N unplottable`) rather than silently absent — which matters most
for the log axes, since nothing about flipping a switch suggests values at or below zero would
leave the picture.

**Shape follows the colour rules exactly, because it is the same kind of channel.** Ranked by
frequency, capped, and the tail folded into one residual mark rather than reusing one — a
repeated mark implies two categories are the same thing, which is why the palette never cycles
a ninth hue either. Six marks rather than eight: shape is coarser than hue at the size a point
is drawn, and a seventh that reads as "a slightly different blob" is worse than an honest fold.
Marks are **area-matched** (`SQUARE = √π/2`), or a square at the circle's radius would be 27%
larger and shape would start encoding magnitude by accident.

**A card gets tick labels; only the titles are held back for the overlay.** `drawScatter` used
to return before the labels under `compact`, and `MARGIN_COMPACT` was 6px on every side — so a
card showed a grid and an axis line with no numbers against them, which is a box of dots, since
an axis without a scale is decoration. The numbers are what say whether the cloud spans ten
synapses or ten thousand. The axis *titles* still stand down: they need another ~22px below the
ticks, and the caption already reads `post vs pre`, so on that surface they are the one label
that is genuinely redundant.

**Gestures match the canvas underneath.** Bare drag pans, Shift-drag lassos, ⌘/Ctrl-drag boxes
— the same assignment `panOnDrag` and `selectionKeyCode="Shift"` give the editor, so the hand
does not change modes when the pointer crosses into a card. Navigation is far more frequent
than selection and gets the bare gesture. Below `CLICK_SLOP` a drag is read as a click: a plain
one selects the point under it or clears, a modified one toggles. The marquee is an SVG overlay
rather than part of the repaint — a gesture that redrew fifty thousand marks per pointer move
is not a gesture.

The wheel handler is a **native listener with `passive: false`**. React routes `onWheel`
through a passive root listener, so `preventDefault` there is ignored and the page scrolls
behind the chart; `nowheel` on the wrapper is the other half, stopping React Flow zooming the
canvas underneath.

**Framing resets on a new question and never on a resize.** The viewport is cleared when the
table or either column or scale changes, because a zoom framed on one pair of columns says
nothing about the next — but a resize changes how much fits, not which picture it is, and
throwing away a zoom because somebody dragged the card's corner is the loss the layout memo
exists to prevent. `equal` aspect is re-imposed after a resize instead, and it **widens the
tighter axis, never narrows the looser one**: narrowing would push data outside the plot, and
an aspect setting that hides points is not an aspect setting.

**The trend fits in transformed space, and per _resolved colour_.** Transformed, so the line is
straight on screen — which makes a log-log fit a power law and a semi-log fit an exponential,
the reading anyone puts a log axis on to get. Grouped by the colour rather than the raw column
value, so each line corresponds exactly to a legend entry: the eight-slot cap and the
achromatic `Other` fold have already happened, so a ninth category's line is drawn for the
bucket the legend actually names. A constant colour therefore collapses to one line by
construction. It declines rather than drawing through fewer than two points or a vertical
cloud — a line through one point is a claim about a relationship nobody observed.

**Ticks needed a second implementation, and that is not duplication.** `niceTicks` in
`format.ts` always starts at zero because a bar chart's baseline does; a scatter's window
routinely excludes zero and always does after a zoom. `axisTicks` covers an arbitrary domain,
and subdivides a narrow log window into 1/2/5 rather than showing two labels a decade apart.

**Marks are batched by `colour|shape`, one fill per bucket.** With a categorical encoding that
is at most nine buckets for any number of points, which is the difference between a redraw
that keeps up with a pan and one that does not. A sequential ramp defeats it by construction —
every value is its own colour — and is left to, rather than quantised: quantising would put a
colour on screen that `resolveColor` never returned.

**`LegendKeys.tsx` was extracted from `NetworkLegend`, not copied.** Two viewers drawing their
own swatches is how two viewers end up disagreeing about what the palette's `Other` bucket
looks like. `ShapeKey` draws the marks through the same `markPath` the plot does, because a
legend that approximated its own marks would be the one place on screen where what is drawn
and what it says may differ — and shape is the fallback channel for exactly the readers a
colour key cannot serve.

**The axes open on named defaults**, `pre` and `post`, rather than empty ones. An empty default
means "the first compatible column", which is the _same_ answer for both axes — so a node
dropped on a neuron table would open drawing a column against itself, a diagonal that looks
like a broken viewer. `resolveColumn` falls back to the first numeric column wherever those
names are absent, so nothing is worse off.

**`evaluate` never refuses over an unpicked column**, and the reason is worth keeping. `out` is
the input unchanged, so throwing because a _drawing_ cannot be configured blocks every node
downstream for a reason that has nothing to do with them — and on the graph that exposed it,
`Pivot → Scatter` reloaded from a file, it was not even true: the pivot publishes no schema
until it has run, so the first Run errored `no numeric columns` while holding a table whose
numeric column the message listed. Passing through lets the run finish, after which the store
re-infers against the schema the pivot has now published and the widget draws — no second Run.
`validate` says nothing at all while the incoming schema is unknown, and the widget's empty
state distinguishes _not known yet_ from _nothing to pick_. See invariant 5's corollary.

**No visual verification exists.** jsdom has no canvas beyond the accept-everything stub, so
the marks have not been looked at by anyone; what is checked is the geometry, the exported SVG
and the caption. Same standing as the WebGL viewers.

### Labels beside the points, and the tooltip's extra columns

From BigClust: once at most `Label up to` (400) points are in view, each is named beside its dot
by the `Label` column. `scatterLabels.ts`' `placePointLabels` is BigClust's placement (`label_placement.py`) and its
choices, measured against the source rather than recalled: **greedy in priority order, first
free slot wins** — eight boxes per point, right first, then the diagonals, left, above, below;
every mark in view an obstacle whether labelled or not, so a name never covers a neighbour's dot;
a uniform grid for the collision test; **the previous slot tried first**, so a pan does not flip
a label to the other side of its point; **selected marks' labels placed first**. Unplaced labels
are left out or drawn faintly, under the rest, and the caption counts what was left out or says to
zoom in while more than the cap are in view. Pure over positions and measured text, so jsdom
tests it.

One departure, chosen: **screen-pixel text** (`LABEL_FONT_PX`, in `canvasFont`'s `--font-ui` face
and measured by the shared `textMeasurer`, so the SVG's `text` is the face the box was sized in), where BigClust sizes in data units
so its labels grow with the zoom. Coda's charts keep text one readable size, so a zoom re-solves
— `pnpm probe:scatter-labels` measured 0.4–0.9 ms for 265–664 points in view on fish2, and the
measured box (`measureLabel`, in the painter's own font) never short of the drawn text. A label
is haloed in the background (`textNode`'s outline in the export), and the SVG carries labels and
leader lines as on screen. **Group labels** — one per value at each spatial cluster's centre —
are deferred; BigClust's island split is quadratic and only safe under its cap.

`Hover shows` lists columns **after** the tooltip's own rows (label, x, y, the colour and shape
columns), leaving out any already shown: adding to the defaults rather than replacing them, so
picking one extra column cannot make the tooltip stop naming what the colours mean. All five
controls are presentational — none changes `Selected`.

### Search, in the strip

BigClust's search, on the expanded card: `⌕` opens a second bar under the strip — a box, a count,
`‹ ›`, `◎` to select every hit (Shift adds, the lasso's own modifier rule), and `⋯` for the column
searched (label and id by default, as the Network Viewer's Find), whole value, case and regex.
`pointSearch.ts` is the matching and reuses Coda's grammar rather than adding a third: a leading
`/` is a pattern (`bareRegex`), an uncompilable one is said (`regexError`), and Exact anchors as
`anchoredPattern` does. **Stepping pans and never zooms** — finding a point is not a reason to
change a scale somebody chose — and rings the hit with the hover ring while its tooltip opens at
the mark; every hit is a **dashed** ring, so a search reads apart from a selection's solid ones, and
it is drawn over the pixel pass too, a zoomed-out embedding being where finding a point is hardest.
The search is view state: nothing reaches the document until `◎` writes a selection.

**The strips are siblings of the plot box, not children of it**, as the Network Viewer's and the
Heatmap's already were. Shipped inside it, the ⌕ did nothing to a mouse: the press bubbled to the
plot, which starts a pan by taking pointer capture, and the browser then delivers the release — and
so the click — to the capturing plot rather than the button. A scripted `.click()` and jsdom's
`fireEvent` both skip that path, so the first build passed every test and opened in a probe that
clicked from script; only `Input.dispatchMouseEvent` (a real press) reproduces it, and the fix was
checked that way in both directions. The test pins the cause — no capture taken for a press on the
strip — rather than the click. (The first fix stopped the events on the strip instead; moving it
out removes the thing to stop.) The viewers built on `usePanGesture` keep their strips inside but
capture only past the drag slop, so a click still lands. Also from that pass: the label texts are
built once per search rather than per keystroke (formatting a numeric column of 129,325 rows was
1.5 s a keystroke), the hit cursor is kept *with the list it indexes* so opening the menu does not
start it over, hit rings go plain past 2,000, the menu closes on an outside press or Escape, and the
Network Viewer's Find matches through the same `pointSearch.ts`, so `/pattern` means one thing in
both boxes.

## Histogram, pie and box plot

Three nodes — `out.histogram`, `out.pie`, `out.distribution` — added together because they make
one design decision together, and because that decision is the opposite of the scatter's.

### Five charts, three nodes

`out.pie` carries a `shape` enum and `out.distribution` a `style` enum, so pie/donut and
box/violin are one node each. Both toggles change the inner radius or which marks are drawn and
nothing else, so both are `presentational` and switching never stales anything. Two node types
apiece would have been two glyphs, two emitters, two guide entries and two sets of tests for one
number and one boolean.

The histogram is **vertical** where the Bar Chart beside it is horizontal, and that is forced
rather than stylistic: a bar chart's categories are ROI and cell-type names, which need rotated
labels as columns, while a histogram's axis is a *number line* — and a number line that runs
downwards is not something anybody reads. The box plot **defaults** to horizontal for the bar
chart's reason, since its axis of names is the category one.

### The box plot's two orientations, and the one thing that knows about them

`orientation` offers groups along the bottom as well as down the side. The default is argued —
these names need rotating 45° as columns — but a box plot is the panel most likely to have to
sit in a figure beside other vertical ones, which is worth the rotated labels.

**One `Frame` knows which axis is which, and nothing else does.** Every mark is placed in
`(value, across)` and mapped once: the violin, the swarm, five box parts, the hit area, the
selection outline, the gridlines and both label rails. A second `if (vertical)` anywhere else is
how two orientations become two charts that agree about the box and disagree about the violin —
and the asymmetry that makes that likely is written into `valuePx`: **screen y grows downwards
and a value axis does not**, so the columns layout runs its axis bottom-to-top. Getting that
backwards everywhere is obvious; getting it backwards in one mark is not.

**The band block is centred in whatever it does not fill**, and the gridlines and the value-axis
labels move with the block rather than with the box. Eight columns capped at 72px use 576px of
an expanded viewer's 1,470; pinned to one end, with the axis stranded at the far edge, that
reads as a chart that stopped drawing half way. Seen in a browser, twice — once per axis.

### The swarm is packed, capped, and drawn last

`swarmOffsets` walks the values in order and gives each mark the offset **nearest the centre
line** that clears everything already placed, taking its candidates from the neighbours
themselves (`offset ± √(4r² − d²)`). A fixed ladder of offsets — 0, ±r, ±2r — is what makes a
swarm look like a bar chart of stacked dots; this one interlocks, which is the shape that reads
as a distribution. Since the input is sorted, the neighbours in range are a sliding window
rather than a scan.

It packs in **pixels**, not in values, because whether two circles overlap is a question about
the screen — so the viewer projects first and packs second, and `Frame.alongPoint` exists so a
swarm never round-trips its positions back through the scale (which under a log axis is not the
identity). A group that packs wider than its band is **scaled** to fit rather than clipped, so a
squeezed swarm does not read as a skewed one.

Two capping decisions. 300 marks per group, then a stable stride and `swarm thinned` in the
caption — a swarm is a plot of every observation, which is its point and also its ceiling. And
the Tukey outliers are **not** drawn on top of one: a swarm already shows them, and drawing them
again doubles the marks that matter most.

**Drawn last, over the box, and the box loses its fill.** The first version painted the swarm
first, so the marks inside the IQR — most of them — were covered by the box, which is a swarm
you cannot see. Order is violin, box, swarm; under a swarm the box is stroke-only. Same order
`sns.boxplot` then `sns.swarmplot` gives, and both emitters follow it.

### A mark is not a row, so a selection is not a set of ids

This is the whole of the design and it is the one place these three depart from `out.scatter`.

A lasso encloses **rows**, so the scatter stores row ids and `nodes/lib/rowIds.ts` owns what a
row is called. A pie slice, a box and a histogram bar are **aggregates**: each stands for
anywhere between one row and a hundred thousand. Storing the rows behind one would put a
category's worth of ids into every saved file and every share link for a gesture whose meaning
is one word — and the ids would then have to survive an upstream re-run, which "the LC4 slice"
does for free.

So `nodes/lib/chartSelection.ts` stores a categorical mark as **its label** and a histogram bar
as **its range**, and both the viewer writing it and the node resolving it import that one
module. Two agreeing implementations of "what is this mark called" drift the first time either
is touched — the standing reason `rowIds.ts` is one module, and the reason this is too.

Three consequences, each of which had to be got right:

- **The range is the bar's own edges, half-open, with a closed flag on the top bar.** The flag
  travels with the range rather than being inferred, because bin count is `presentational` and
  therefore absent from the cache key — `evaluate` has to resolve one bar without knowing how
  many there were. Without it the largest value in the table falls outside every bar in a
  picture that plainly contains it.
- **The residual slice hands back the categories folded into it, not the word `Other`.** Same
  reason: the fold depends on `maxSlices`, which is presentational, so a stored `"Other"` would
  quietly come to mean a different set of rows after somebody widened the chart, with nothing
  re-running to say so.
- **Exactly one column param per node is not `presentational`** — the one the selection is
  resolved against. `value` on the histogram, `category` on the pie, `group` on the box plot.
  It decides which rows `Selected` carries, so marking it presentational would let a stale
  downstream result survive a change to it (invariant 4). Precisely the call `out.scatter`
  makes for `idColumn`, and note that it lands on a *different* param each time: the histogram
  names its bars after the value column and the box plot names its boxes after the group one.

The cost, stated: those params are absent from the overlay's presentational-only rail, exactly
as `idColumn` is on the scatter. They are still on the card and in the inspector.

### The caps, and what each does with its tail

Every one of them is a drawing decision that reports itself rather than a refusal — see
[limits.md](limits.md).

| | cap | the tail |
| --- | --- | --- |
| Histogram | 80 automatic bins, 200 by hand | — |
| Histogram series | 8 + `Other` | folded, achromatic |
| Pie | `maxSlices`, default 8 | folded, achromatic, and it remembers its members |
| Box plot | `maxGroups`, default 24 | **dropped**, and counted in the caption |
| Violin | 4,000 values per kernel estimate | stable stride |
| Swarm | 300 marks per group | stable stride, `swarm thinned` in the caption |
| Outliers | 200 marks per group | stable stride, count in the tooltip |

The box plot is the odd one and deliberately so. Folding a tail into one achromatic bucket works
for a bar and a slice because those are **sums**; pooling fifty cell types into one box makes a
distribution that describes nothing. Dropping and saying so is the honest version of the same
cap.

Both strides are stable rather than random, for the scatter's reason: a random sample reshuffles
per render, so a violin's shape and its outlier dots would move on every repaint and the picture
would never be the same twice.

The eight-slot fold itself is **`foldByRank` in `colors.ts`**, shared with the bar chart. It was
four copies of one loop until these three arrived, and the copies had already drifted: two
tie-broke equal totals by label and two did not, so two charts assigned hues from `Map`
insertion order — i.e. from whichever row the backend happened to return first — and two were
stable. The shared one keeps the tie-break.

### Freedman–Diaconis needs a fallback, and the fallback is the interesting half

`chooseBinCount` sizes a bin from the interquartile range. A column whose middle half is one
value — `pre` on a table that is mostly zero, which is an ordinary table here — gives a width of
zero and an infinite bin count. Sturges answers from `n` alone and cannot, which is what makes
it the fallback rather than a second opinion. The 80-bin ceiling is the other half: FD on a
heavy-tailed integer column asks for thousands of mostly empty bars, and the picture at 80 and
the picture at 3,000 answer the same question.

Neither exporter reproduces this exactly and both say so in a note. seaborn's `bins="auto"` is
the larger of FD and Sturges with no cap; ggplot has no automatic rule at all and defaults to
30. A bar count that differs is the kind of thing that gets blamed on the data.

### Quantiles are computed in value space; the kernel estimate is not

A quantile survives any monotone transform, so `Log axis` leaves the median, the quartiles and
the box exactly where they were. The **Tukey fence is not** invariant, and computing fences in
log space would silently reclassify outliers the moment somebody flipped a switch that is
supposed to change only the axis. The violin's kernel estimate *is* computed in the space the
axis is drawn in, because a density is a statement about area and a log axis redistributes it —
the same rule the scatter's trend line follows.

Two smaller decisions in `boxStats.ts` worth not undoing. The whisker ends at the **most extreme
value inside the fence**, not at the fence: drawing the fence puts the whisker end at a number
no row holds and makes it stick out past the data whenever the tail is short. And every violin is
normalised against **one peak across all the groups**, so widths compare between them — rescaling
each to its own maximum makes a flat distribution and a sharp one the same shape.

### A pie refuses negatives, and it is the only chart here that refuses anything

An angle is a share of a whole and a share cannot be less than nothing. A `-40` beside a `100`
either draws backwards over its neighbour or quietly makes the total 60, and both are a picture
that lies. Negatives are dropped, counted, and reported in the caption. A bar of −40 is perfectly
readable, which is why this is a property of the pie rather than a rule.

The full-circle arc is the other thing to know: a 360° sweep starts and ends at the same point,
so a single elliptical arc renders as **nothing at all**. `arcPath` draws it as two half arcs,
and a single-category pie is not a rare case.

### Selection reads as displacement, not as colour

Colour is already the categorical channel and every slice is using it, so a "selected" hue would
either collide with a category's or say two things at once. A selected slice pulls out along its
own bisector; a selected histogram bar takes an outline and the unselected ones dim; a selected
box takes a band outline. Dimming is applied to the **unselected** marks rather than as a
highlight on the selected one, so with nothing selected — the common case — every mark is at full
strength.

Every bar and every box also carries a **full-height transparent hit area** under it. Without one,
a two-pixel bar in a long tail is a two-pixel target, and the tail is what somebody clicking a
histogram is nearly always after.

### The row scan is memoised apart from the drawing

Each of the three splits its work in two — `scanValues`/`binScan`, `groupValues`/`summarise`,
`tallyCategories`/`pieSlices` — and the viewer keys the two halves on different things. The
first is O(rows) and depends only on the table and the columns; everything a styling control
touches is in the second, which is O(bars) or O(groups).

That split is not premature. `NumberField` fires `onChange` on **every pointer-move** of a
scrub-drag rather than on commit, so `Bins`, `Max slices` and `Max groups` each emit ~60 param
changes a second while dragged — in up to three live viewer instances at once. Keyed as one
memo, a drag on `Bins` re-walked 165,000 rows per frame.

Two measured numbers came out of the same pass. Freedman–Diaconis needs quartiles and therefore
a sort; a fixed bin count needs neither, and the extent comes from the scan — so the sort is
taken **only on the automatic branch**: 20.6 ms against 0.2 ms on 165,122 values. And
`kdeCurve` walks a two-pointer window rather than testing every value at every grid point,
which is what the sortedness of both inputs is for: 9.5 ms against 5.3 ms at the default cap,
bit-identical output, and a test pins it against the naive form because a pointer that reset
one element late would still draw a plausible violin.

### What was checked in a real browser

The suite covers the arithmetic (`histogramBins.ts`, `pieLayout.ts`, `boxStats.ts`, all
headless), the mark counts, and — the part that matters most — **what a click writes back**,
since that string is what a node resolves into rows. It cannot cover anything about pixels, so
these were driven in Chrome against the mock optic lobe, in the card and in the expanded
overlay. Three things it caught, all of them invisible to a green suite:

- **The box plot's bands were a fixed height.** Ten groups clustered in the top third of an
  expanded viewer with six hundred pixels of gridline under them and the tick labels pinned to
  the bottom of the card — which reads as a chart that failed to draw. Bands now stretch to fill
  and stop at 72px, the gridlines end where the bands do, and the axis sits directly under them.
- **`niceTicks` rounds its top up past the data**, so the box plot drew a `600` label out in the
  right margin with no gridline under it. Ticks are now bounded at both ends of the domain.
- **Two `defaultSize`s were too short and one label step too tight.** The pie's ring had no
  height left at all once its params, legend and caption were laid out — a card drawing a key to
  a picture that was not there — and the histogram's edge labels touched at 34px per label
  (`formatCompact(126.4)` is five glyphs at ~5.6px). All three numbers are measured now, and
  `sortSlices` moved to the inspector to buy the ring its rows back.

## Rank Plot: a heavy-tailed measure, and the denominator every other view lacks

A connectome is full of measures that span decades over a long tail — influence scores, degree,
centrality, cluster sizes, NBLAST scores, synapse counts — and until this node the only way to
draw one was a bar chart, which is the wrong mark for every one of them. Linear, the largest bar
is full and the rest are slivers. Logged, a thousandfold difference draws as a **1.7x difference
in length**: `influenceLog` is `log(max(x, e^-24)) + 24`, so a bar chart of it is a plausible
figure saying the measure is flat when it is not. Length encodes ratio and these ratios do not
fit in a length, so the mark is a dot on a log axis.

### The share is the half that is not otherwise reachable

The ordering alone is not the question people have. What makes this answer *is this driven by a
handful of things or diffusely?* is the running share of the total beside it, and nothing in the
app could draw one. `out.histogram` has a `cumulative` control and it answers a **different
question**: its curve is over **rows** — "90% of neurons score below 1e-4" — where this one is
over **values** — "the top twenty carry 60%". Only the second is what a concentration question
asks, and no amount of configuring the first produces it.

Two panels sharing the rank axis, **never two y-scales**. A Pareto chart with the cumulative on
a twin axis is the one chart construction with no honest reading, and the split buys something
besides: the share panel has room for its own annotation, which is where `half by rank 71` goes.

### Where it refuses, and why that is the share and not the ranking

`rankSeries.ts` holds everything a reader could be misled by, headless for the standing reason —
jsdom performs no layout, so arithmetic left in a `.tsx` is covered by roughly nothing.

**A share of a total means nothing over a signed column.** Ranked descending, a column that can
go negative has a running sum that climbs past the total and comes back down: a curve that looks
exactly like a Lorenz curve, reaches 1.4, and is not one. So the panel is withheld with
`shareRefusal` naming the reason, the caption says `no share`, and **the ranking above is
untouched** — the ordering is still a real answer, and refusing the whole picture would claim
otherwise. The second refusal is an all-zero column, where there is no total to take a share of.

**A flagged row is ranked and not counted.** `Flag column` is a picker rather than a boolean
because nothing here knows about influence — but an Influence result is what it was built for.
Seeds are kept in that table deliberately (a seed's score is its own seed mass plus whatever came
back round a loop, which is a real measurement about recurrence), and left in the share they
carry most of it and the curve says nothing. So a flagged row is plotted, ringed, ranked, and
excluded from **both** halves of the share. On the demo graph that is visible as a share curve
flat across the first 44 ranks and rising after them.

Which gives the third refusal, and it has to be asked **before** the all-zero one or it answers in
that one's words: a table where *everything* is flagged has a total of zero for a reason that has
nothing to do with the values. Not a contrived shape — an Influence walk seeded with every neuron
in a small connectome flags all of them, which is exactly what the wizard's synthetic demo does —
and "every value is zero" there names a column that is full of scores.

**What is dropped is counted by reason**, because the fix differs: a missing or non-numeric value
is a column that is not what the picker thinks it is, where a value at or below zero is a *scale
the reader chose* and is included again the moment Log value comes off.

### The one thing `validate` catches that the resolver cannot

An Influence table carries both `influence` and `influenceLog`, and pointing Value at the second
with Log value on takes the log of a log — which on a heavy tail is very nearly a straight line
whatever the data does. A clean-looking power law for reasons that have nothing to do with the
connectome, which is the worst kind of wrong figure. `validate` names it; `resolveColumn` cannot,
because both columns are numeric and both are real.

### What was checked in a real browser

Driven through the app on the synthetic dataset (`dataset.mock.opticlobe` → Find Neurons →
Influence → Rank Plot), which needs no credential and reaches no server. Three things came out of
looking at it, and none is reachable from jsdom:

- **The caption printed the row count twice.** `plural(n, noun)` already formats the number, and
  the call had one in front of it.
- **The value axis drew a single tick label.** `logTicks` spends its budget on *decades* and then
  strides, so asked for three over a four-decade span it strides by two and lands on 0.001 / 0.1
  / 10 with only 0.1 inside the data. The count is the number of decades worth showing rather
  than the number of labels wanted, so it is now derived from the panel height with a floor.
- **The direct labels overlapped into a band.** On a log rank axis the leading five ranks sit
  inside the first fifth of the width, so labels on one line collide — five of them all reading
  `LC4`. Staggered over three rows.

The gesture was checked the same way: a horizontal drag brushes a range of the ranking and a
press that does not travel clears, which is `CLICK_SLOP` deciding between the two. There is
**no zoom**, and that is what frees the drag — a log rank axis already fits the whole table,
which is the reason it is the default.

### What the exporters do

Both draw it. The ordering, the stable tie break, the share of the values and the refusal are a
generated helper (`coda_rank`) in each language rather than lines in the cell, because two of
those rules are ones a reader would not write by hand and cannot see the absence of.

Python gets `plt.subplots(2, 1, sharex=True)`, which is the card's own arrangement. **R gets two
figures rather than two panels**, and that is stated in the cell: a scale *transform* in ggplot
belongs to the scale and not to the facet, so a log value panel and a linear share panel cannot
be two facets of one plot, and the libraries that would stack them — patchwork, cowplot,
gridExtra — are each a dependency this document does not have.

One trap the goldens found, and it is about the fixture rather than about either emitter:
**`neuron.influence` is refused in R**, so nothing binds its output there and every node
downstream of it is skipped. A single Rank Plot fed from Influence therefore left the R emitter
written and never once executed by a golden, with every coverage test passing — the walk checks
that the node *type* is in the graph, not that its cell reached the document. Hence two fixture
nodes, and the plain one is fed from Connectivity.

## Line Chart: numeric columns against one numeric X

`out.lineChart` (`nodes/output/lineChart.ts`, `ui/viewers/LineChartViewer.tsx`, the rules in
`ui/viewers/lineSeries.ts`). Built for voltage traces (the biophysics pack's Simulate Model), and
deliberately a node of its own rather than lines on the Scatter: the Scatter's model is one row, one
mark, with colour-by, size-by, labels, a lasso that outputs *rows* and trends per group, and a
several-Y picker would turn a row into several marks and give each of those a special case.

- **A line is a (series value, Y column) pair**, so a wide table (Simulate Model's `t`, `soma`, `site 1`…)
  and a long one (a Series column) both draw without an Unpivot, and both together draw every Y for
  every series, labelled `series · Y`. **Empty Y is every numeric column but X and Series**
  (`yColumnsOf`, headless in `nodes/lib/lineChart.ts` so the export plan resolves it too and the
  notebook gets the literal list the canvas drew; only an unknown schema falls back to each
  language's spelling of the rule). The picker says so with `ColumnsParam.emptyLabel`,
  `multiEnum`'s field given to column multi-pickers, and the assistant's catalogue prints it for
  both kinds.
- **Joined in X order or in row order** (`Join`). X order sorts each line stably; row order is for a
  path that doubles back. Empty cells are **skipped and the line runs across the gap**; both
  exporters drop them before plotting for that reason (matplotlib and ggplot would break the line).
- **Decimation is M4 per pixel column** — first, lowest, highest, last — and only on an X-ordered
  line, whose columns mean something. Y refits from the decimated samples, which keep each column's
  extremes, so a zoom frame reads the data once. A one-sample spike survives on screen and in the
  SVG, where a stride would step over it. Unsorted lines are drawn whole.
- **The crosshair reads every line at one X**: each line's sample nearest the pointer, one tooltip
  row each (twelve, then a count), dots on the lines.
- **Zoom is along X only** (wheel about the pointer, drag to pan once zoomed, double-click back),
  and **Y refits to the window**, so a 2 ms onset on a 100 ms trace fills the height. Y alone is
  never zoomed: a trace zoomed in voltage alone is a trace cut off. The window resets when the
  table, X or its scale changes.
- **Colours cycle** (`cycleColor`, the `Palette` param) — a line keeps its own mark, so folding into
  `Other` buys nothing; the key lists twelve and says `+N more`, the caption `colours repeat`. A
  single line draws no key.
- **A second Y axis** (`Y2`, decided 2026-10-17), for a quantity in other units beside the rest — a
  current beside voltages. Its lines are **dashed** (the user's choice over a side-tagged key or an
  axis inked to match: the axis a line is read against shows on the line itself), each axis fitted
  to its own lines, the right one with ticks and labels but **no grid of its own**, which would
  cross the left's. Colour continues the cycle across both axes; the key and the crosshair name a
  right-hand line `(right)`. **Empty Y leaves Y2's columns out** (`yColumnsOf`'s fifth argument),
  so on Simulate Model's Traces picking `injected` is the only setting. The exporters: matplotlib's
  `twinx`, colours counted across both axes by hand (a twin axis restarts the cycle, so its first
  line would share the left's first colour); ggplot2, whose second axis is only a transform of the
  first, maps Y2 linearly onto Y's range and labels the right axis with the inverse — the same
  picture, each axis spanning its own data — and draws a log on either axis linear with a note,
  no linear map carrying one through: a log is presentational, so the chart is still the answer,
  the Heatmap's notes' rule rather than a refusal. The `(right)` tag is one constant (`Y2_TAG`,
  beside `yColumnsOf`) for the key, the crosshair and both legends. Both emitted cells were run on
  a synthetic table, the R one with a series too.
- **A tap**: every param presentational, the table through by identity with its `neurons`-ness.

Measured in Chrome on Simulate Model's traces (1,001 samples, soma and three named record sites): four
lines, the crosshair reading all four, and a zoom to 18–52 ms refitting Y to −0.2…−1.1 mV.
