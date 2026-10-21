# Viewers: heatmap and dendrogram

The two matrix-shaped viewers: the Dendrogram and the Heatmap. [viewers.md](viewers.md) holds what
every viewer shares — export, tooltips, table filtering and the styling sidebar.

## Dendrogram: naming leaves without renaming the tree

A `LinkageValue` knows its leaves by one `string[]`, taken straight off the matrix's row labels
— and a `MatrixValue` axis is also just `string[]`. So on every route into `Linkage` except
NBLAST's, a leaf is a bare root id: `core.similarity` labels its rows with the observation column
it was given, `neuron.adjacency` and `core.pivot` the same, and none of them offer a choice.
NBLAST is the exception only because it has `Label by`, which reads a column off
`skeletons.attributes` and writes the result into the matrix.

The `Annotations` port on `out.dendrogram` is the general answer, and it is a *viewer's* port —
it names what the drawing says and never what the value carries. `displayLabels`
(`nodes/lib/displayLabels.ts`) is the whole operation: match the leaf's own label against a
column of a wired table, take another column as its name.

**The tree keeps its identity, and that is the reason this is a decoration rather than a
relabel.** `Selected` carries a `label` column that `cluster.selectedToNeurons` matches against a
neuron table. Rename the *tree* by cell type and a clade of fourteen neurons resolves to every
neuron of those five types in the connectome — a plausible, wrong answer with nothing to raise.
So `evaluate` never reads the port at all, both pickers are `presentational`, and the annotation
is recovered downstream for free, since `Selected to Neurons` carries the neuron table's own
columns onto its output. The payoff of that discipline is that trying `type`, then `instance`,
then `hemilineage` costs nothing: no provenance key changes, so the `expensive` Linkage above
never re-runs.

**The join is `labelsByNeuron`**, which is the same operation — an id column and a label column
of *some* table — and already had three callers (`partnerVectors` calls it with two picked
columns over an arbitrary table, which is exactly this shape). Its rules come with it: a blank
annotation is no label, the first non-blank row wins a repeated id, and ids resolve through
`idText`, so a table carrying them as `i64` drops the ones that were already rounded rather than
naming whichever neuron owns the rounded value — invariant 8. That last case presents identically
to "no annotations wired", which is why the node's `validate` says it out loud; the warning is
`relabelTable`'s, one node over.

What `displayLabels` adds is only the guard: the four ways of having nothing to look anything up
in, which `labelsByNeuron` answers by throwing (it reads through `getColumn`) and a viewer asked
to draw whatever is on the wire this frame has to answer with a picture.

**An unnamed leaf keeps its own label**, which inverts `core.relabel`'s `Unmatched` default on
purpose: there, an unmapped value passing for a mapped one is the confusion being prevented,
where here a blank leaf is strictly worse than the id it replaced. The caption counts them
(`12 unnamed`) on the `labels thinned` idiom, because a tree where a third of the leaves are
still root ids looks like a half-broken join and usually is one.

**Cell types repeat, so the identity moves to a `<title>`.** `Label by: type` routinely gives
fourteen neurons five names, and then nothing else on screen says which leaf is which. It is an
SVG `<title>` rather than the `chart-tooltip` the brackets use — one string per drawn label,
shown by the browser for free, where a hover handler per label would put a `setHover` and a
re-render of the whole tree between the pointer and three thousand of them. It sits in a `<g>`
**beside** the `<text>` rather than inside it: both are spec'd identically (a `<title>` is never
rendered), but only one of them needs that to hold in every renderer an exported SVG lands in,
and jsdom cannot answer the question either way — it concatenates descendant text, so a test
asserting the drawn label reads `aLC4`. The form with no question is the one to ship.

**The Heatmap has the same port and it is the opposite kind of thing**, which is the pairing
worth reading together — the wizard offers both (`tree` → dendrogram, `ordered` → heatmap), and a
reader who has met one will assume the other behaves the same way. It does not. A heatmap's axis
labels are **data**: the Filter tab matches on them and the Order tab sorts by them, both declared
`affectsData` and both running in `evaluate`. A presentational rename there would put `LC4` on
screen while a filter typed `LC4` matched nothing — a silent mismatch, and the worse kind because
the picture looks right. So `out.heatmap`'s `Annotations` joins in `evaluate`, ahead of the filter
and the sort, and the names reach the CSV, the notebook and every node below. `NBLAST`'s
`Label by` is the standing precedent for that direction: "the labels are part of the matrix that
leaves the port, not a way of drawing it."

What it spends is exactly what this port exists to keep. A relabelled axis no longer carries the
id it arrived with, so a `Linkage` below a named Heatmap clusters lines called `LC4` and
`Selected to Neurons` under *that* would match cell types against a neuron table — the failure
this port was designed around, one node further down. It is a decision the user makes by wiring
a table rather than one the node makes for them, the node counts what the table did not name, and
the help says to put a Linkage that needs ids above rather than below. What was rejected is a
third spelling: a separate `Relabel Matrix` node on [core.relabel](../src/nodes/table/relabel.ts)'s
shape would have been the same operation reached through a card, with two answers to one question
and nothing saying which won.

**The two halves are one function.** `displayLabels` is the join plus the guard — four ways of
having nothing to look anything up in, all of which mean "keep the labels that arrived" — and
each caller decides whether the answer is a drawing or the value. `relabelMatrix`
(`nodes/lib/matrixShape.ts`) is the write half, beside `takeMatrix` because the three tabs are one
module: it hands the matrix back **by identity** when nothing changed, and passes the cells
through **by reference**, an axis rename that copied four million doubles to change two strings
being a fold's worth of work for nothing.

**No `Unmatched` control, inverting `core.relabel` for a sharper reason than the dendrogram's.**
There a blank leaf is merely worse than the id it replaced; on an axis it is worse than that —
several blanks collide, the Filter box can no longer address those lines, and `Order by: one row
or column` loses a key it could have named. So an unnamed line keeps its own label, and the
*count* is what is said out loud, in two messages that are two different states: **none** named on
an axis is a control pointed at the wrong place (`Apply to` covering an axis of ROI names, say)
and the message names the two controls that fix it; **some** named is an ordinary incomplete
annotation table and gets a count. All named says nothing.

**Both exporters write into the pass-through**, which is the one line where they diverge from the
dendrogram's emitters — there the relabel reaches `dendrogram(labels=…)` and a copy of the tree,
and nowhere else. Python needed `set_axis` and a rebind rather than `df.index = …`: the
pass-through is bound by reference, `heatmap = similarity_matrix` is one frame under two names,
and assigning to `.index` renames the upstream variable so a later cell reads axes the canvas
never gave it. R is safe by copy-on-modify and still assigns `rownames`/`colnames` on the local
matrix. Both were **run** rather than parsed — `probe:helpers` and `probe:r-helpers` carry the
whole emitted shape, including the aliasing check and the filter that follows it.

**Both exporters emit the relabel, into the plot and nowhere else.** `dendrogram(labels=…)` in
Python and a copy of the tree with its `labels` replaced in R — never an assignment back into the
pass-through variable a later chunk reads, which would hand `Selected to Neurons` cell types to
merge on.

**The join itself is `coda_relabel`**, the registered helper `core.relabel` already emits, which
carries first-occurrence-wins and `coda_match_keys` — and that last one is why hand-rolling it
was wrong rather than merely repetitive. Spelled inline the key was `.astype(str)`, where an
`i64` column carrying one null is `float64` in pandas and prints `'101.0'` against a leaf label
of `'101'`: the notebook would have matched **nothing** and drawn root ids while the canvas drew
cell types, silently, on exactly the dtype the node's `validate` warns about. Verified by running
the emitted cell against a float64 id column rather than by reading it.

The one rule left inline is dropping blanks, because `coda_relabel` maps a matched-but-null to
null where a leaf has to keep the label the matrix gave it. That half was also wrong until it was
**run**: `dropna(subset=['type'])` keeps the empty string, so a neuron whose type is `''` — which
neuPrint returns for an untyped body and every CSV upload can carry — drew a blank leaf in the
notebook where the canvas drew its id. The fixture carries the wire, so both goldens hold the
branch.

### Zoom and pan: one axis, because the height is the data

`⌥`-free gestures, `HeatmapViewer`'s exactly — wheel zooms about the pointer, a drag pans,
double-click or ⤢ fits, a `×N` note in the caption — and off the canvas only, where the card is
not a 150px preview React Flow already zooms. What differs is the shape of the window and two
pieces of pointer bookkeeping.

**One axis.** `DendrogramWindow` is `{ at0, atSpan }` along the leaf axis; the distance axis is
never windowed. The heatmap's two axes are the same kind of thing — matrix lines — so one
magnification over both is right there, and stretching one alone would make a block read as a
different shape. A dendrogram's are not: the leaf axis is a list of `n` slots and the distance
axis is the *measurement*.

It was built both ways, and the two-axis version is wrong in a way only a browser shows. On a
real 398-leaf tree at ×8.7, zooming about a pointer part way up the distance axis moves the
window off the leaves: the card came back as a column of readable names beside two brackets and
an acre of empty space, because the merges joining what you are reading sit *below* the window —
which is exactly what you zoomed in to look at. Holding the distance axis whole fixes that and
buys two more things: a merge sits at the same fraction of the plot at every zoom, so two zoom
states are comparable, and the root's crossbar spans every leaf, so the spine of the tree is
always on screen. The case the other version would have served — a single-linkage tree with every
merge crushed near zero — wants a log height scale, which is a different control.

The consequence to know is that **a drag along the distance axis does nothing**, and that is by
construction rather than an oversight: vertical for leaves-at-the-bottom, horizontal for
leaves-on-the-right. Both were driven in Chrome.

**The window is the drawing's input, not a transform over it** — `HeatmapWindow`'s rule for a
sharper reason. A scaled bracket takes its labels with it, and 10px leaf names blown up to 40px
is the one thing a zoom must not do. So `visibleLeaves` re-thins the names for the pitch the zoom
gives them and `visibleLinks` drops the brackets the window cannot reach. Measured in Chrome:
397 brackets and 67 names fitted, 51 brackets and 46 names at ×8.7, with `labels thinned` gone
from the caption.

**Everything the window feeds is memoised, and that is not a micro-optimisation.** `clampWindow`
returns a fresh object, and the window is a prop of the memoised `DendrogramLinks` — so an
unmemoised one fails its shallow compare on *every* render, including the `setHover` that fires
on each pointer move over a bracket. That is 4,000 `linkPath` calls and 12,000 elements
reconciled per pointer move on a fitted tree: precisely the cost that component exists to avoid,
and it would silently have voided `visibleLinks`' returning `shape.links` **by identity** at the
fit, which is the other half of the same arrangement. `visibleLeaves` is memoised beside it
because it is O(leaves) unconditionally, and the gutter's `longest` is folded into the `names`
pass rather than reduced again — the three of them were the whole of the hover path's O(n) work.

`visibleLeaves` itself is arithmetic rather than a scan: `dendrogramShape` builds its leaves with
`Array.from(linkage.order, …)`, so index `i` *is* slot `i` and `at` is `(i + 0.5) / n`, strictly
increasing. Inverting that is two divisions where a filter was 20,000 comparisons and two arrays
of that length on a card drawing sixty names. A pan is still a genuine re-render of every visible
bracket, and the culling is what keeps that affordable.

The floor is **one leaf filling the plot**, so the maximum magnification is the leaf count — a
four-leaf tree has nothing to show at ×1000. `clampWindow` is applied on the way *out* as well as
in, because a window stored at 400 leaves is out of range the moment the clustering upstream is
filtered to 40.

**The wheel itself is `useWheelZoom`**, shared with the heatmap. The non-passive listener (React
routes `onWheel` through a passive root listener, so `preventDefault` there is ignored and the
overlay scrolls behind the chart), the per-frame coalescing of a trackpad's faster-than-frames
delivery, and the `0.0015` sensitivity were all written out three times — and the third copy had
already drifted, listing the window in its dependency array and so tearing the listener down and
putting it back on every render, cancelling any queued gesture step with it. The hook reads its
callback through a ref, which is what makes attaching once per element compatible with seeing
this render's window. `ScatterViewer` is its fourth caller. Its three drag gestures are still its
own, and so are the heatmap's — both capture the pointer at the press, where `usePanGesture` waits
for the slop, which is the change a shared drag gesture would make and one only a browser can check.

**Three things exist only because this viewer's purpose is clicking branches**, which the heatmap
has no equivalent of:

- **Pan runs only while zoomed.** Fitted, the pointer belongs entirely to the brackets; a drag
  handler live at the fit would make every selection a one-pixel gamble.
- **A drag that becomes a pan must not select the clade it was dragged from.** A ref — a
  ref, not state, because `pick` is a `useCallback` handed to the memoised `DendrogramLinks` and
  anything it reads that changes per render would put every bracket back through reconciliation
  on each pointer move. A click fires after `pointerup`, so by the time `pick` asks, the ref
  describes the finished gesture — which is also why the pan state carries no `moved` flag of its
  own: the ref has to outlive the gesture anyway, and two spellings of one fact is one of them
  going stale. `CLICK_SLOP` sits beside `tooltipPoint`, which both gesture handlers already
  import for the other half of the same question.
These two are `usePanGesture`'s now, extracted when the ROI viewer became the third copy of this
function — `useWheelZoom`'s history one gesture over. They are recorded here because this is where
both were found.

- **Pointer capture is taken at the slop, not at the press.** Captured from `pointerdown`, the
  subsequent `click` is dispatched to the capturing element rather than to the bracket under it,
  so selection would silently stop working the moment anybody zoomed in. Taken once the gesture
  has travelled far enough to stop being a click, a pan that runs off the edge of the card keeps
  going and nothing that was still available is lost.

Two smaller findings, both from the browser. A pan drags across leaf labels and the browser's
default for that is to **select** them — a zoomed tree came back with half its names highlighted
blue, which the heatmap never had because its plot is a canvas. `user-select: none` only while a
pan is live, so a label stays selectable the rest of the time; `preventDefault` on the
`pointerdown` is the other fix and is the wrong one, since cancelling it suppresses the
compatibility mouse events and the click that selects a branch goes with them. And the two clip
regions are **the plot and the gutter**, the gutter clipped along the leaf axis only — a name
lives outside the plot along the distance axis by definition, and clipping it there erases every
label.

## Heatmap: more cells than pixels

`out.heatmap` used to refuse above **20,000 cells**, and that number was a fact about SVG rather
than about matrices: every cell was a `<g>` wrapping a `<rect>` carrying its own `onMouseMove`
and `onMouseLeave`, so the cap was really 40,000 DOM nodes and as many listeners on one card. It
landed on exactly the pictures this viewer exists for — an NBLAST score matrix at the Skeletons
node's own 500-neuron ceiling is 250,000 cells, and `Linkage → Ordered → Heatmap` is _meant_ to
be read at that size, where the structure is texture rather than cells.

There are two numbers now, and the same reasoning ran a second time. `HEATMAP_CELLS_WARN`
(**4,000,000**) was the refusal; it is now where the caption says `large matrix`, because the
measurement above says paint tracks the **grid** rather than the matrix — sixteen times the
cells is sixteen times one 23 ms fold on first layout, not sixteen times every frame. The
refusal moved out to `CRASH_FLOOR_CELLS` itself, read straight rather than aliased, so this
viewer draws anything a Pivot or an NBLAST can build and declines only what could not have been
built. See [limits.md](limits.md).

**The fold is the part that scales, and it is on the resize path.** `buildHeatmapSpec` is
memoised on the card's width and height and `useElementSize` has no debounce, so a resize drag
re-folds once per pixel step: 12 ms at 2M cells, 40–56 ms at 8M, 65–104 ms at 16M. Below the old
4M ceiling that was invisible; at the new one it is a laggy drag on a matrix that could not
previously be drawn at all, which is the trade the caption names.

`heatmapPlot.ts` is the headless half — geometry, the fold, the hit test — and `heatmapDraw.ts`
is the canvas pass and the standalone SVG, both reading one spec. `scatterPlot`/`scatterDraw`'s
arrangement, for its reasons: jsdom has no canvas, so anything left in the component is covered
by nothing, and one spec is what makes the exported file the picture on screen.

### The fold is the whole of it

**A cell smaller than a pixel is not drawn.** The matrix is folded onto a grid of at most one
cell per CSS pixel of the plot, and the canvas pass, the SVG export and the hit test all work on
that grid — so **drawing costs the card rather than the data**. Only the two passes that cannot
be bounded stay O(n): the extent scan and the fold itself. Measured in a browser at 1400×700,
spec build then first paint: 90,000 cells 1.2/5.6 ms, 250,000 3.2/17 ms, 1,000,000 11/37 ms,
4,000,000 20/46 ms. So the ceiling costs about 65 ms of one frame, on a resize or a theme flip
and never on a hover.

**CSS pixels, not device pixels**, so the picture does not change between a retina screen and a
projector, and the exported SVG — which draws the same grid — is the same file whoever exported
it. What is given up is the sub-CSS-pixel detail a 2× screen could have shown.

**A block keeps its strongest cell, never the mean.** A connectivity matrix is sparse, and
averaging one strong connection across the hundred empty cells beside it puts it at a fraction of
a percent of the ramp — off the picture, which is the only thing in it. Strength is measured from
the scale's own neutral end (the low end for sequential, zero for diverging), so a diverging fold
keeps both tails rather than only the positive one, and a sequential fold keeps the largest value
rather than the largest magnitude. Same brightest-wins rule as `raster.ts`.

**The winning cell's index is kept**, so the tooltip over a folded block names a real row, column
and value — and says `strongest of ~N cells` beside it. That admission is on the _card_ as well
as in the overlay, which matters, because the caption's `cells merged` note stands down under
`compact` as every viewer note here does. A folded picture that said nothing anywhere would be
the failure `labels thinned` already exists to prevent.

### Canvas for the cells, SVG for everything else

This is the one place the viewer departs from `ScatterViewer`'s all-canvas call, and the
arithmetic licenses it rather than taste. A scatter's tick labels are a handful either way; a
heatmap's axis labels are bounded by **pixels**, since only so many 10px names fit down an edge
however large the matrix is. So the labels, the printed cell values and the hover outline stay in
an SVG overlay: real text that can be selected, found and read aloud, laid out by the browser
rather than by `measureText` — and a hover that costs one element rather than a repaint of four
million cells. `.heatmap-overlay` is `pointer-events: none`, or a label would put a dead strip
across the row it names.

Axis labels are **thinned to a legible pitch and the drop is counted**, which the old code never
had to do because it never drew a matrix taller than its own labels.

### The chrome is shared, not drawn twice

The cells were shared from the start (`cornersByBucket`), and the labels and printed values were
not — two independent drawings carrying the same magic numbers, and they **had already parted
company** after one afternoon: a cell whose bucket is `-1` took ramp-bottom ink on screen and
black in the file. `axisMarks`/`valueMarks` in `heatmapPlot.ts` now return placed, coloured
`TextMark`s that the overlay maps to JSX and the exporter to `<text>`, so the file matches the
card for the chrome as well as for the cells.

**A `TextMark` carries its baseline, and absent means alphabetic.** `dominant-baseline: central`
centres text across its _reading_ direction, so on a column label turned -90° it moves the label
sideways by half a cap height and the whole band drifts off the columns it names. Applying it
uniformly is the obvious tidy-up and it is wrong; it was caught by pixel-diffing against the
previous build, since jsdom performs no layout and nothing else here can see a two-pixel move.
`heatmapPlot.test.ts` pins the row/column distinction.

### Two things measured rather than assumed

- **The ramp is a 512-entry lookup table, and that is not the quantisation `ScatterViewer`
  refuses.** That viewer declines to quantise a sequential ramp — "quantising would put a colour
  on screen that `resolveColor` never returned" — so this was checked over 200,000 samples of
  both scales in both modes. The ramps are piecewise-linear in RGB and the output is 8 bits a
  channel, so the whole blue ramp is **453 distinct colours** and the diverging scale 621–1,006;
  against those, 512 steps is within **one** channel value of exact for sequential and **two** for
  diverging, and 256 measures the same. The scatter's objection is real for a _categorical_
  palette, where a substituted slot means a different category; here a colour is a magnitude and
  the substitute is the same magnitude to within a rounding step. Without the table, 285,000
  `sequentialColor` calls cost **65 ms against 2 ms**, per render.
- **Cells are batched by ramp bucket, and carried as flat corners.** One path and one fill per
  bucket, so a bounded number of fills for any number of cells — the scatter's colour+shape
  batching arrived at from the other direction, since there the sequential ramp defeats the
  batching and here the ramp _is_ the batching. Every cell is the same size, so only `x, y` is
  stored per cell and the width and height are read off the spec once: that alone took a
  four-million-cell repaint from **77 ms to 46 ms**, most of the difference being garbage no
  longer made.

`buckets` is **mode-independent** by construction, so a theme flip re-resolves the ramp's hex and
repaints rather than re-folding the matrix — and the derived form is memoised against the spec in
a `WeakMap` (`rowFields.ts`'s `slotCache` idiom), so that repaint does not re-walk 900,000 grid
cells to change nothing but the colours. Measured, it took the four-million-cell repaint from
46 ms to 27 ms and made an export cost no third walk. Two caches now, keyed the same way and for
the same reason: `cornersByBucket` for the SVG's batched paths, `gridImage` for the canvas's
pixels — the latter keyed on the ramp as well, since a theme flip changes the ramp and not the
spec.

**`Show values` is applied at render, never in the fold.** It reached `buildHeatmapSpec` only to
decide one boolean, which put it in the dependency list of a pass that walks every cell — so
toggling it on a four-million-cell matrix re-scanned the whole thing to compute `false`.
`labelsFit` is now the size test alone and the param is `&&`-ed in beside it.

### The colour domain: two manual ends and a log mapping

Both are presentational, so neither reaches the provenance key — and both go through
`colorDomain`, which is the one place a value's position on the ramp is decided. That matters
more than it sounds: `normalize`, the hoisted `bucketScale` the fold runs per cell, the hit
test and the SVG export all read the same domain, so a log mapping could not be applied to the
cells and missed by the export.

**A limit is a `string` param and empty means automatic.** `NumberField` coerces anything
unparseable back to the declared default, so a `number` param has no unset state and would need
a sentinel — and `0` is an ordinary limit. `readColorLimits` parses both, and **drops an
inverted or unreadable pair rather than honouring half of it**: a ramp running from 10 down to 1
would clamp every cell to one end, which is a picture of one colour with no explanation, so the
caption says `limits ignored` instead. Out-of-range cells clamp to the end they passed, as they
do in matplotlib, and the caption admits that too (`values clipped`) — a cell silently painted
the same as the maximum is the failure that admission exists to prevent.

**On a diverging scale there is one end to set, not two.** The arms have to stay the same length
or the neutral colour stops meaning zero, which is the only thing that ramp is read for, so
`Max` is the magnitude of both and `Min` is not offered there.

**The log is on the colour and on nothing else.** `log1p(v − lo) / log1p(span)`, so the printed
cell values, the tooltip and the two ends of the colour bar are the numbers themselves — a log
scale is a way of *looking* at a distribution, where a relabelled cell is a way of misreading
one. The shift by `lo` is what makes it total: `lo` is the bottom of the ramp, so `v − lo` is
never negative and the logarithm always exists, even on a matrix that goes below zero. With the
usual `lo` of 0 it is exactly `log10(1 + v)`, which is what both exporters emit — natural logs
here and base 10 there draw the same picture, since a ratio of two logs is base-independent, and
a test pins that. It is offered on the sequential scale alone: a diverging ramp's two arms are
already a signed magnitude, and taking a log across the middle compresses the two sides
differently.

Two things fall out for the rest of the module. The mapping stays **monotonic**, so the fold's
"strongest cell in the block" rule is unaffected and needed no log-specific case. And `bucketScale`
keeps one `Math.log1p` per cell — there is no algebraic way around it, and it measures at about
8 ms over four million cells, inside the fold that was already the expensive pass.

The exporters had to work for it. seaborn colours the transformed frame while **`annot` takes a
frame of its own**, so `annot=heatmap` keeps the printed numbers raw where the fill is a
logarithm of them; ggplot gets a `fill_` column clamped and transformed beside the untouched
`value` the label reads, which is also how the clamp is expressed without reaching for
`scales::oob_squish`. Both were run: the annotations come back as the raw values, `-3` and `200`
included, and nothing goes NA at a limit.

### Circles: the same number twice, and three decisions that are not the drawing

`Cell shape` draws each cell as a disc whose **area** is its value. A connectivity matrix is
mostly empty and the squares paint that emptiness as the bottom of the ramp, which on Coda blue
is very nearly the surface — so the picture is a dark field with a few highlights. Circles make
the sparsity the *shape* of the plot: on the 34x34 demo the T4/T5 → LPLC block and the Mi1
column read at a glance where the squares needed the colour bar.

**Area, not radius** — `resolveSize`'s rule one encoding over, so the radius takes a square root.
A circle of twice the radius reads as four times the quantity, and that is the relation readers
actually compare.

**It reads the bucket, not the value**, which is the decision that keeps the two encodings from
ever disagreeing. A bucket is already the value's position on the ramp, so a log colour, a manual
`Min`/`Max` and the clamping at both ends all reach the radius for free — `colorDomain` stays the
one place a value's position is decided, exactly as it is for `normalize`, the hit test and the
export. The alternative, a second scale over the raw values, is two mappings that agree until
somebody ticks Log colour.

**Size is distance from the domain's `neutral`**, which is the low end of a sequential ramp and
the centre of a diverging one: a radius cannot be negative, and on a diverging scale the sign is
what the colour is already carrying. So the circle says *how much* and the hue says which way,
which is `corrplot`'s division. One trap there, and a test found it rather than an eye:
`RAMP_STEPS` is **even**, so a diverging centre falls exactly between buckets 255 and 256 and
`bucketOf` rounds it to one side — the two arms then reach 256 and 255 buckets and equal
magnitudes either side of zero drew *different* circles. 0.2%, invisible, and a claim the mark
must not make, since symmetry about the centre is the whole of what "the hue says which way"
means. The neutral point is taken in continuous bucket space now.

Three things were decided rather than derived, and each had a live alternative.

**A cell at the neutral end draws nothing.** That is most of why the mark is worth having — an
unconnected pair is an empty cell. What it costs is that a recorded zero and a cell nobody
measured look alike, where the squares tell them apart (`-1` shows the surface, 0 takes the
ramp's bottom colour); and a manual `Min` above the data's floor hides those cells here rather
than flattening them, which the caption's `values clipped` says the related half of. The
alternative was a ~1.5px floor so every recorded cell keeps a dot, which preserves that
distinction and makes a sparse matrix look like a full grid of dots — i.e. gives up the thing
the mark was reached for.

**Too dense means squares, and the card says so.** Circles need a cell several pixels across, and
past one cell per pixel the grid is folded and a block stands for many cells drawn as the
strongest of them — a circle there would be sized by a value that is not the block's, in a
space one pixel wide. So `circlesFit` is a **size test on the spec** and the param is `&&`-ed in
at render, which is `Show values`' recorded arrangement: folding the choice into
`buildHeatmapSpec` would put it in the dependency list of a pass that walks every cell. The
fallback is not permanent — the fold is per *window*, so zooming in brings the circles back.
`too dense for circles` is the **second caption note not stood down under `compact`**, and for a
different reason from the selection count's: that one is about the picture, this one is about a
*control* somebody set that is not in effect, and the card is where it nearly always fires, a
preview plot being a couple of hundred pixels for however many rows. `CIRCLE_MIN_CELL` is 5,
measured by eye in a browser at several sizes — it is a legibility threshold and a screen is the
only instrument for one.

**Neither exporter follows, and both say so.** seaborn's `heatmap` is a tile renderer, so the
notebook would have to leave it for a melted scatter and rebuild the colourbar, the ticks and the
annotations by hand, while ggplot is a one-geom swap — and taking only the cheap half would leave
the `.Rmd` and the `.ipynb` from one card showing two different marks. So both draw tiles and
carry `HeatmapColourPlan.shapeNote`. Saying so is the point rather than a hedge: the palette, the
limits and the log are all presentational too and all followed, so a reader has every reason to
assume this one was.

Two implementation notes. The batching is **free** here in a way the squares' is not — a radius
is a function of the bucket alone, so every cell in a bucket is the same circle and one `fill()`
covers all of them; and circles are only reached unfolded at `CIRCLE_MIN_CELL` per cell, so a
1400x700 plot holds at most ~39,000 of them however large the matrix is. And the printed values
ask their ink **per mark**: a square fills its box so `inkOn(fill)` is always right, where a
circle covers the text only near the top of the scale and below that the text sits on the
surface — so the radius is compared with the text's own half-diagonal and the loser takes
`inkOn(background)`. A flat "circles means surface ink" would be wrong for exactly the marks that
are easiest to read.

### Zoom is a window, and the window is the fold's input

Wheel zooms about the pointer, a drag pans, double-click or ⤢ fits — the scatter's gestures,
and off the canvas only, where the card is not a preview React Flow already zooms. What was
decided is what the state *is*: a `HeatmapWindow` in **matrix units** (fractional rows and
columns), handed to `buildHeatmapSpec` as the thing to fold. A zoomed heatmap is therefore not a
scaled picture of the fitted one. The visible lines are folded onto the plot's pixels, so zooming
in on a four-million-cell matrix folds *fewer* cells than the fit did, and past 1:1 the real
cells appear with their own labels and printed values where the fit showed blocks. Scaling the
canvas would have kept the fitted fold's blocks and enlarged them, a picture claiming detail it
does not have — and the labels would have scaled with it, which is the one thing they must not
do.

**The labels never scale.** The gutters are fixed, and `labelTicks` re-thins for the pitch the
zoom gives each line, so a 2,000-row matrix that showed every ninth name at fit shows every name
at ×10. A line part way off the plot is named over the part that is on it — at ×15 a line's own
centre can be in the next gutter, naming nothing anyone can see — and a line with less than a
label's pitch on screen goes unnamed *and uncounted*: it is not a label the thinning dropped,
and counting it had the caption say `labels thinned` over a plot showing every name it could.
Both found in the browser, not in jsdom.

Each axis is an `AxisMap` — which lines the grid covers, how many grid cells, the pitch, and the
pixel the grid starts at, which sits *before* the plot's edge by the fraction of a line the
window starts into. One mapping, `gridIndexOf`, serves the fold, the hover ring, the printed
values and the hit test, so a zoomed cell cannot be drawn in one place and hovered in another.
Both renderers clip to three zones (`TextMark.zone`): the cells and values to the plot, each
gutter's labels to its own gutter — so a zoomed export is the zoomed card, clipped the same way.

**The canvas is an image now, and the reason was measured rather than guessed.** On a 401 × 401
matrix the first wheel step took 264 ms and the gesture only became usable below about a hundred
visible lines. Marks around every JavaScript stage said spec 3 ms, chrome 0 ms, paint 8 ms — the
time was nowhere the code could see. A 2D context records commands and rasterises them at the
frame, so the 160,000 anti-aliased rectangle edges the bucket-batched paths asked for cost the
*frame* ~250 ms that no measure around `fill()` includes. The fit paid it once; a zoom paid it
per event. `drawHeatmap` now writes one pixel per grid cell into an `ImageData`, puts it on a
scratch canvas of the grid's own size and blits it to the plot with smoothing off — nearest
neighbour is exactly the picture the rectangles drew — with the 1px separator drawn over it as
one line per grid line. Re-measured: 60 ms on the first step and the Playwright round-trip floor
(~40 ms) on every step after, at every zoom. The SVG export keeps the paths: a raster in a vector
file is the one thing it exists not to be. Wheel events are also coalesced to one update per
animation frame, since a trackpad delivers them faster than frames.

**Two label bugs the same browser run found, neither visible in jsdom.** Every k-th line was
chosen by its distance from the *first visible* line, so a pan or a zoom re-picked which lines
were named on every step — labels blinking under the pointer; it is now `index % step`, so a line
keeps its name until it scrolls off. And the sliver test compared a line's visible extent with
`min(line, pitch)` exactly, which for an interior line is one number computed two ways: rounding
dropped 29 of 47 row labels in a pattern that changed per step. A tolerance of 1e-6 fixed it, and
`heatmapPlot.test.ts` now asserts the named lines are evenly spaced.

Two things were separated on purpose. The **colour domain is memoised apart from the window**,
so a pan does not rescan the matrix and a zoom cannot change what a colour means — the domain is
the whole matrix's and is handed in. And the window is in matrix units so a **resize keeps the
zoom** where a pixel viewport would keep the pixels; a new matrix, on the other hand, gets a new
frame, since a zoom framed on one result says nothing about the next. Driven in a real browser
on the 34 × 34 demo Adjacency: ×15 in six wheel steps, a drag that panned, ⤢ that fitted, no
console errors.

### Selecting a rectangle, and why it is stored as positions

Shift- or ⌘/Ctrl-drag draws a box; the rows and columns it covered leave the node as
`Selected Rows` and `Selected Columns`. Bare drag still pans — `ScatterViewer`'s division and
React Flow's `panOnDrag`/`selectionKeyCode`, so the hand does not change modes crossing into a
card, and navigation keeps the frequent gesture. Expanded only, where the zoom and pan already
live: on a card `compact` is true and shift-drag belongs to the pane's own selection box.

**The selection is a set of positions, and it was labels first.** `chartSelection.ts`'s standing
rule is to store what a mark *means* so it survives a re-run, and the argument for names here was
real: the Order and Filter tabs are on the *same card as the gesture*, so positions re-point the
moment somebody sorts the picture they just selected from. It shipped that way and was reported
as a bug within the hour, because **a heatmap's names are not identities**. The Labels tab exists
to replace root ids with cell types — one-to-many by design — so a box drawn round one cell of a
fourteen-row `LC4` block selected all fourteen. That is not a defensible reading of a rectangle:
a rectangle is a statement about the lines under it and nothing else.

So the cost is taken the other way round, and it is the smaller one. **A re-point is visible on
the card the instant it happens**; a name quietly widening a selection is visible nowhere and
reaches `Selected Rows`. The help says to select after arranging the matrix rather than before,
and the caption's count is what shows the change. The general shape is worth keeping: "store the
meaning, not the position" assumes the mark *has* a meaning that is unique, and a viewer whose
whole job is to rename things is where that assumption stops holding.

**Alt adds** — the scatter's modifier for the same thing — as a union rather than a toggle: a
second box overlapping the first is somebody extending a selection, not asking for the overlap
back, and a toggle over a folded block where one grid cell stands for a hundred lines is a
gesture whose result nobody could predict. Clearing is the **⌫ button** in the strip beside ⤢,
or a modifier-click with no drag — but not while Alt is down, where the gesture was "add" and
adding nothing should take nothing away.

**One param, both axes**, `r:`/`c:`-prefixed. Two params would be two commits, so an undo would
take back the columns and leave the rows — `attachEdgeSet` records that trap one layer down. The
two *outputs* stay separate because a row and a column are different populations downstream.
Entries are **sorted**, so two gestures selecting the same lines write the same param and a
re-selection that changed nothing does not move a provenance key. A non-integer entry is dropped
rather than resolved, which is what a selection stored by the label-based build degrades to:
`r:LC4` is not a position, and reading it as one would select whichever line sat at a plausible
index.

**The drawing is bands, and they are outlined rather than tinted.** Colour is the data on this
viewer, so a translucent wash over the selection would change what every cell inside it appears
to say. Runs rather than one rect per line: an added block is a second run by construction, and a
folded axis puts hundreds of lines on one grid cell. Rows span the plot's width and columns its
height, which draws a **cross** rather than the box that was dragged — honest, since the two axes
leave as two independent lists, and the same picture a spreadsheet draws.

#### No colour can sit on top of a ramp, so the band is a pair and a dash

The band was a 1.5px `--accent` line — blue, on a viewer whose **default palette is Coda blue** —
and the report was simply that it could not be seen. The fix looks like a colour choice and is
not one. Worst-case contrast against any cell of any of the twelve palettes, both themes:

| band | worst | where |
| --- | --- | --- |
| `--accent` (what it was) | **1.07** | every ramp has a cell it matches |
| yellow `#ffd400` | **1.04** | viridis, inferno and magma — their top _is_ yellow |
| white | 1.45 | |
| black | 1.96 | |
| **white over black** | **4.59** | PuOr's mid purple |

So the answer is not a better hue: **a ramp crosses the whole hue circle and every lightness**, so
for any single colour there is a cell it vanishes against. Yellow is a reasonable instinct and
measures no better than the blue it would replace — worse, in that its blind spots are the tops of
the three most-used published ramps. A light-and-dark _pair_ works because any cell is lighter or
darker than mid grey and the other tone then reads; white over black clears the **4.5:1 floor for
text** against every cell there is. `encoding.test.ts` pins that, so a thirteenth palette cannot
quietly break it. Drawn as **two layers of the same rects**, every casing beneath every core, or
one band's casing overdraws its neighbour's core. Widths 4 under 2, which leaves exactly 1px of
casing either side: equal widths hide the casing, and less than 2px of difference anti-aliases the
edge into grey at 1x.

**And the core is dashed, which the contrast number could not have told anyone.** Found in a
screenshot: the band's other neighbour is not a cell, it is the 1px separator _between_ cells — and
that separator is not painted at all, it is the surface showing through. So on each theme one of
the casing's two tones is already the grid. Light theme plus a palette whose low end is black
(inferno, magma, rocket) draws a black field ruled in white, and a solid white band in it measures
4.59:1 and still reads as a slightly brighter white line among white lines. Dashing the core fixes
it by changing the **kind** of mark rather than its colour: the grid is solid and continuous, so an
interrupted line cannot be mistaken for one at any palette or on either theme. That it is also how
every image editor draws a selection is the second reason to want it, not the first.

**Thinner on a card**, where the same band is a different fraction of the picture: a preview plot
is a couple of hundred pixels across with cells two or three wide, so 4px covers several rows of
what it is pointing at. 3 under 1 there against 4 under 2 expanded — and the casing stays exactly
2px wider rather than scaling by the same factor, which would have put it at 0.75 and
anti-aliased the whole band into grey. The dash shortens with it (4/3 against 7/5), a long
pattern on a short band showing two dashes and reading as a broken line rather than a deliberate
one. `heatmap-plot--compact` is the hook; jsdom resolves no stylesheet, so the tests pin the class
and the browser pinned the widths.

The hover ring is the same `stroke` against the same cells and has not had this treatment — it is
transient and the pointer is already on it, so the eye knows where to look.

**`label` and `relabel` are two columns because the Labels tab spends the identity.** `label` is
what the line was called on the way in (the id), `relabel` what the card showed; where nothing
renamed anything they are the same string. Keeping them aligned is the whole of why `evaluate`
tracks the *arrival* names through the filter and the sort — through the identical index lists,
which is what `orderIndices` exists for — it hands back the index lists and the caller applies
them, so the follower's derived list reaches both. Deriving `label` at the end
from the drawn name is impossible by construction: naming by type is one-to-many.

**Eleven properties only a browser could check**, which is `pnpm probe:heatmap-select`: that a
shift-drag selects what it covered *and only that*, that a bare drag does not select, that the
bands land on the rows they cover, that the marquee appears and goes, that a shift-click clears,
that alt-shift-drag and shift+⌘-drag each add and leave the blocks as separate bands, that a
shift+⌘-click with no drag takes exactly one cell, that the strip is the fit button alone, and
that a card takes the gesture without moving the canvas's node selection. jsdom performs no
layout, so the spec there is degenerate and `linesInRect` has no geometry to convert.

### Three chords, a click, and the card

The gesture grew in four ways at once and each one turned out to be about something other than
the heatmap.

**Shift+⌘/Ctrl adds**, beside the Alt that already did. `isAdditive` asks whether a press is a
selection at all (Shift **or** ⌘/Ctrl, the canvas's own chord), so the *adding* chord has to be
something neither alone already means — Shift+⌘ is that, and it reads as the selection chord with
more of it. Alt is **kept** rather than retired: it is `ScatterViewer`'s modifier for the same act
one viewer over, and a heatmap that answered a hand's Alt+Shift by *replacing* what it had just
added to would be the quiet kind of wrong. Two chords for one act is the price and it is paid in
the help table.

**A press with no drag in it is a rectangle covering one cell**, on an adding chord — and it is
`cellAt`, not a zero-width `linesInRect`. The degenerate rectangle is the obvious reuse and it is
wrong twice: `pointToMatrix` is a bare linear map with no bounds of its own, so a press in a label
gutter comes back *clamped* and silently takes line 0; and a press landing exactly on a line
boundary spans `[k, k − 1]`, which is empty. `cellAt` is what the hover ring and the tooltip
already ask, so a click takes what the card was pointing at — on a folded block, the strongest
cell it is drawn as rather than the hundred behind it. What it costs is inherent and the help says
it: the two ports are independent lists, so one cell is a row *and* a column, and two clicked
cells are a cross rather than a pair.

**The ⌫ button is gone and ⤢ stays.** It was a control with two better spellings already — a
shift-click on the plot, and the Selection tab's own field — and a third that could only be
reached by expanding. ⤢ is *fit to view*, which reads as inert because it is `disabled` until
something has been zoomed; it stays because it is the only discoverable reset, because
double-click is not a thing anybody guesses, and because the Scatter, Dendrogram and ROI viewers
all carry the same strip. The gestures lived in ⌫'s `title` and moved to ⤢'s, which is the control
that is there whenever they apply.

**Selecting moved onto the card, and the gate was never about cards.** It was `!compact`, recorded
as "shift-drag belongs to the pane's own selection box" — which is true, and is a fact about *where
a press lands*: with `selectionKeyCode="Shift"` React Flow's pane claims a shift-press **anywhere
inside it**, our canvas included, takes the pointer capture and stops propagation in the *capture*
phase, so the card's own handler never ran. `nokey` on the plot container is the library's own
opt-out (one guard, `event.target.closest('.nokey')`, and nothing else in React Flow reads it), and
with it the press reaches the heatmap while a pane rubber band still starts from empty canvas.
Zoom and pan stay expanded-only — those are `zoomable`, and a preview React Flow already zooms has
no business carrying a second zoom — but selecting writes a param, and making somebody expand a
card to do it was a step in the way.

Two things the browser said and nothing else could. **The gesture was also moving the canvas's node
selection**: `nodrag` filters the d3 drag, where a node's selection rides on the `click`, which
fires anyway — so one shift+⌘-click took a cell *and* selected the card, and building a selection
cell by cell piled up cards that the next Delete would have removed. Measured 0 → 1, and 0 → 0
after an `onClick` that stops a *modified* click at the canvas; a bare one still passes through,
because clicking a card to select it is what a card does. And **the selection count is the one
caption note not stood down under `compact`** — every other note is a thing worth saying about a
picture and is dropped for room, where this is the only acknowledgement a card gives that the
gesture landed, the bands saying *where* but not, on a preview that has folded a thousand lines
onto two hundred pixels, how much.

The jsdom side needed two stubs before any of it could be tested at all, and they were load-bearing
for every pointer gesture in the app rather than for this one. jsdom implements **no
`PointerEvent`**, so `fireEvent.pointerDown(el, { shiftKey: true })` fell back to a bare `Event` and
every modifier, button and coordinate arrived `undefined` — the handler runs, reads a falsy
`shiftKey`, and takes the branch for a gesture nobody made. And it implements **no pointer capture
at all**, not as a no-op but as an absent property, so the `setPointerCapture` every drag here takes
on the press threw a `TypeError` *inside* the handler before the gesture was recorded. Both read as
the handler simply not having run: no error surfaces, the spy is just never called. `installJsdomStubs`
now supplies a `MouseEvent` subclass and three no-ops, which is why `ScatterViewer`, `RankViewer`,
`usePanGesture`, `ViewerDock`, `DashboardCellView`, `ParamField` and `groupDrag` are all newly
testable for the *wiring* of their gestures — the geometry stays the probes'.

**Two of them were wrong before they were right, and both wrongnesses were the probe's.** The
band check, read by *shape*, passed against the column band — which spans the plot's whole height
and therefore contains every row tick on the card; `data-axis` on the rect is what distinguishes
them, and the wrong reading reported 23 of 23 rows correctly banded where they need not have
been. And the count check compared against tick centres strictly inside the box, reporting 10
rows selected against 9 — `linesInRect` takes every line the rectangle *touches*, so a row whose
centre is just outside is genuinely selected. That is the near-miss that invites a tolerance where
what is wanted is the right rule; the pitch comes off the ticks and the comparison is against the
rows the box overlaps.

### The palettes are transcribed, and the stop count was measured

Beside Coda's own two ramps the heatmap offers matplotlib's and seaborn's — viridis, magma,
inferno, plasma, cividis, rocket, mako, and the ColorBrewer diverging sets RdBu, PuOr, BrBG. The
categorical `PALETTES` rule applies unchanged: a published set is transcribed, never mixed, and
here the transcription was done by a script against the installed packages rather than typed.

**64 stops, not 256, and not 32.** The packages hold 256 entries per ramp; `sampleRamp`
interpolates linearly between stops and the cells are quantised to `RAMP_STEPS` anyway, so the
question was how few stops reproduce all 256 within the tolerance the lookup table is already
held to. Measured, maximum channel error against the 256-entry table:

| stops | viridis | magma | inferno | plasma | cividis | rocket | mako |
| ----- | ------- | ----- | ------- | ------ | ------- | ------ | ---- |
| 16    | 7       | 3     | 6       | 5      | 10      | 3      | 3    |
| 32    | 2       | 2     | 2       | 3      | 6       | 1      | 1    |
| 64    | 1       | 1     | 1       | 1      | 2       | 1      | 1    |

So 64 is within two channel values everywhere — the same bound `RAMP_STEPS` clears for the
diverging scale — and 32 is where cividis starts banding. The ColorBrewer sets are different:
matplotlib holds exactly eleven anchors at 0, 0.1 … 1 and interpolates linearly between them,
which `sampleRamp` does too, so storing the eleven **is** the colormap rather than a sampling of
it. `heatmapPlot.test.ts` pins the shape (64 and 11) and the endpoints.

**Not flipped with the theme.** Coda's own ramp reverses so "nothing here" recedes into whichever
surface it is on; the published ones run as published, dark end low, on both — which is how every
reader has seen them in a paper, and what makes `cmap='viridis'` in the exported notebook the
picture on the card. On the light surface a low cell is therefore dark, exactly as in matplotlib
on white. RdBu keeps red at the negative end for the same reason; somebody who wants blue there
has Coda's pair.

### The export

`svg: () => heatmapToSvg(...)` rather than the live element, because the live element no longer
holds the cells. **A folded picture exports folded** — the cells below a pixel were not on screen,
so drawing them would be a document claiming detail nobody saw, and one rect per cell of a
four-million-cell matrix is a file nothing opens. Bucket-batched there too: a 356×356 matrix
exports as 54 `<path>` elements carrying 82,236 subpaths, 2.0 MB, and parses clean.

**Two pre-existing bugs in the shared export path had to be fixed to get there**, and both are
the same shape: two owners for one declaration.

`serializeSvg` set the namespace with `setAttribute('xmlns', …)`, which creates an ordinary
attribute in the _null_ namespace that merely happens to be spelled `xmlns` — so `XMLSerializer`
emitted it beside the declaration it already writes for an element created in the SVG namespace,
and **every chart this app exported carried `xmlns` twice**. A duplicate attribute is a fatal XML
well-formedness error rather than something a reader recovers from, and SVG is parsed as XML:
`DOMParser` returns a `parsererror` document for it. It affected the bar chart, the scatter, the
network and the dendrogram alike, and it failed to _parse_ rather than looking slightly wrong,
which is why nothing about the string ever caught it.

And `serializeSvg` appended a `<style>` inlining the font **unconditionally**, beside the one each
builder already appends — measured on a real export: two style blocks, the serializer's saying
`sans-serif`, because `getComputedStyle` on a _detached_ element resolves nothing and a
synthesised export is always detached. Only document order saved it: `insertBefore` happened to
put the dead declaration first. Moving that to an append, or a builder dropping its own, would
have silently stripped the typeface from every exported chart.

**The fix is structural rather than advisory, which is the point.** `setAttributeNS` makes the
namespace a real declaration so exactly one is written, the font is inlined only when the element
carries none, and `svgElement.ts`'s **`svgRoot()` has no parameter for `xmlns` or `font` at all** —
so a fourth builder cannot reintroduce either by copying a third. The first pass fixed this with
three identical comments saying "do not set xmlns", which was verified to be worthless:
re-adding the attribute to `networkToSvg` left all 43 builder tests green, because
`networkDraw.test.ts` asserts `toContain('xmlns="…"')` and that passes just as happily when it is
written twice. `svgBuilders.test.ts` is the tripwire under it — every builder's output through the
real `serializeSvg` and a real XML parse — and both halves were confirmed by mutation.

### What was checked in a real browser

Headless Chrome over CDP against `pnpm dev`, because this is the class jsdom cannot see.

- **The small case is unchanged.** The bundled matrix example rendered before and after and
  pixel-diffed: **cell interiors byte-identical**, and the only differences are the two output
  pixels the 1px separator straddles, where the canvas and SVG rasterisers weight a sub-pixel
  edge differently by 1–11 values. 3.6% of the frame, all of it on the separator lines. The same
  diff was re-run after the shared-chrome refactor and came back at **zero** differing pixels,
  which is how the baseline regression above was found.
- A 356 × 356 adjacency (126,736 cells) drawn on a card and expanded, against the old build
  answering `205 × 356 is too large to draw (72,980 cells)` on the same graph.
- The tooltip on a folded card, saying `strongest of ~2 cells` and landing under the pointer.
- The SVG export captured off `URL.createObjectURL` and re-parsed in the page: no `parsererror`,
  one `xmlns`, 54 paths, labels present.
- **Light theme, loaded fresh**: labels `#52514e`, the low end resolving to `#cde2fb` and the
  surface to `#fcfcfb` — all through `currentMode()`, so a viewer computing hex in JS survives.

**A live theme switch does not repaint this viewer, and that is pre-existing** — checked against
the old build, which left its labels `#ffffff` and its cells `#134789` on a light card in exactly
the same way. `currentMode()` is read during render and nothing re-renders the card on a theme
change; any subsequent edit fixes it. Not introduced here and not fixed here, because it is one
symptom of something several viewers share.

**+6.7 kB raw / +2.5 kB gzipped on the main chunk** (1,002.41 → 1,009.11 kB), measured against a
build of the same tree with the feature absent. Far under this codebase's bar for a lazy boundary.

Three things were lifted out rather than copied a third time, on the second-consumer rule this
codebase states repeatedly (`useStable`, `LegendKeys`, `Tiles`, `raster`): `svgElement.ts` holds
`SVG_NS`, `round`, `element`, `textNode` and `svgRoot` for all three SVG builders; `canvas2d.ts`
holds the HiDPI setup the scatter and the heatmap share — and it now skips the `canvas.width`
write when the size is unchanged, which was reallocating a ~16 MB backing store on every theme
flip; and `labelStep` moved from `dendrogramLayout.ts` to `format.ts` beside `truncateLabel`,
because two thinning rules that round differently drop different numbers of labels under captions
that both say `labels thinned`.

What has **not** been looked at is a matrix at the four-million ceiling in a browser — the mock
connectome tops out at 401 neurons, so the ceiling's cost is measured against synthetic data
through the real functions rather than through a real graph.
