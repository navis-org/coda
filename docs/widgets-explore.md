# Widgets: Explore Dataset

Explore Dataset: the browsing widget. [widgets.md](widgets.md) is the index.

## Explore Dataset: the browsing widget

The entry point for someone who does not yet know what to ask for. `Find Neurons` is
procedural — state a regex, get a result; `Explore Dataset` holds a dataset's **entire** neuron table,
searches it as you type, pages through it and lets you tick individual neurons. `New ▸ <dataset>`
builds `Dataset → Explore Dataset → Table`, which is what the start page's dataset rail opens.

**The whole dataset is downloaded once and searched locally.** Fuzzy-matching every field of
every neuron cannot be a query per keystroke against a shared production Neo4j. Measured on
male-CNS v1.0: 165,122 Traced neurons of 176,422 total, × 20 properties = 26 MB of JSON, **6.9 MB
gzipped, ~5 s**; it parses in ~85 ms and substring-scans in ~6 ms. Local search is not merely
viable, it is faster than a round trip could ever be. hemibrain is 186,061 rows in ~3.8 s.

**The dataset's population checkboxes narrow the list, never the download.** The cached table is
always every `:Neuron`; `narrowPopulation` filters the rows on load, so one dataset read two ways
shares a single 26 MB entry rather than keying two. The card reads them off the dataset **type**,
not the value — it loads before any Run, and a value-side read would show 186,061 rows on a fresh
session and a fraction of that once somebody pressed the button. They are OR-ed, so a second
ticked box lists *more* neurons rather than fewer. See
[datasets.md](datasets.md#the-population-checkboxes-and-the-default-that-was-removed-once-already).

**Cached in IndexedDB, not `localStorage`** — 26 MB is five times the whole localStorage budget.
`data/cache.ts` degrades to an in-memory Map wherever IndexedDB is missing (node, private mode),
because a failure to _remember_ must never look like a failure to compute. The cache fingerprint
is the column list, so an index cached before schema discovery learned about `superclass` is a
miss rather than a table that disagrees with the type being advertised downstream.

**Three ports, and the viewer hangs off the second.** `Hits` is everything matching the query;
`Selected` is only the ticked neurons, resolved against the whole index so refining a search
never drops something already chosen; `All` is the index itself. The starter wires `Table` to
`Selected` because `Hits` with an empty search is the entire dataset.

**`All` is the index handed on unchanged, and it is free.** Neither the search nor `Max hits`
touches it — a port called All that narrowed with the search box is the worst of both — and it
returns the _same_ `TableValue` the loader did rather than a copy, which is only safe because
columns are immutable by contract (`core/values.ts`). The point is that the download is already
paid for: 26 MB of every-neuron-every-property becomes an ordinary table for a group-by or a
chart with no second query against a shared production Neo4j. It sits **last** in the output
list so the two ports every saved graph is wired to keep their socket positions, and so a link
dragged off the node still starts from `Hits`. Note what it is _not_ — an escape from
provenance: a downstream `Filter` on `All` re-runs locally, but Explore Dataset itself is still
`expensive`, so the first Run of a session still waits for the index.

**Node `expensive`, widget live — the split is the design.** Typing filters the widget's own copy
of the index immediately and never runs the graph; the committed query lands as a param after a
140 ms debounce, marking the node stale so downstream waits for Run. `cheap` would re-run
everything downstream per keystroke; searching only on Run would make the list feel dead. Paging
is `presentational`, so browsing invalidates nothing.

**Fuzzy is a fallback, not the default.** A term matches as a substring; only when the whole
query finds nothing is it retried as a subsequence, and the result carries a `fuzzy` flag the
caption shows. Running both at once was the first design and real data killed it: `DNp01`
reported **4,389** hits against male-CNS instead of 2. The right ones ranked first, but a hit
count off by three orders of magnitude is its own lie. As a fallback it still catches typos
(`mechnosensory` → `mechanosensory`) without inflating every count.

**A bare regex is opted into with a slash, and matched per field.** `^LC4$` typed on its own is
the *literal* substring `^LC4$` and finds nothing; `/^LC4$` is the pattern. The opt-in is the
feature rather than a syntax tax: a box that compiled every term reads `LC4(R)` as a group and
returns `LC4R` beside it, which is exactly what `escapeRegex` exists to prevent, and a search
widening itself by a row with nothing on screen to say so is the worst shape that bug takes. The
slash is neuroglancer's convention for the same control; a closing `/` is optional, because sed
and vim have taught everybody to write one and it would otherwise be a pattern ending in a slash
that matches nothing. Three consequences: it runs against **each searchable field separately**
(an anchored pattern cannot match a row's joined haystack — `"10 LC4 visual"` — so the haystack
implementation passes every other test and fails only this one); it is **exempt from the fuzzy
retry in both directions**, since a pattern is an exact question asked on purpose; and it reads
the index's own field list, so the `Search tags` opt-out hides a column from a regex exactly as
it hides it from free text. Measured at male-CNS size (165,122 rows × 11 fields, ~20-character
values): **26 ms** for the literal substring pass against **29–38 ms** for a regex, worst case
being a pattern that matches nothing and therefore tests every field of every row. Same order as
the pass that was already there, so nothing is precomputed for it.

**Ranking is a bucket partition, not a sort.** Five tiers (exact / prefix / substring in
`type`|`instance`|`neuronId` / substring anywhere / subsequence), so it is O(n) and can rank
_every_ hit. An earlier version gave up above a threshold, which left the real DNp01 neurons
thousands of rows deep in a 21k-row fuzzy set — i.e. "fuzzy search does not work".

Non-obvious rules pinned by tests: a missing value satisfies `!=` and nothing else (so
`status!=Traced` finds the untraced _and_ the unlabelled, where SQL's three-valued logic drops
both, silently); regexes are **unanchored**, deliberately unlike neuPrint's `=~`, because this
search is local and has no server semantic to match — which is what makes `^` and `$` yours to
type; and only `neuronId` and string columns join
the free-text haystack, so `1200` does not match a synapse count.

**A thumbnail cache remembers masks and never refusals.** A mask is a fact about the geometry;
a refusal is a verdict from a policy — the byte ceiling, the multi-resolution requirement — and
policy changes when the code does. Persisting one silently outlived raising
`THUMBNAIL_MAX_BYTES`: every neuron the old 128 kB ceiling had turned down (DNp01 among them)
stayed a placeholder through any number of reloads, because nothing ever asked again, and the
entry carried neither a fingerprint nor an expiry. The session's in-memory map still holds
refusals, which is all that was ever needed to stop a page turn re-requesting; forgetting them
across reloads costs one manifest read. Stored masks now carry a `MASK_FORMAT` fingerprint, and
a stored mask with nothing in it is read as a miss rather than as a refusal — either one alone
retires the bad entries, and `explore.test.tsx` seeds a real one to prove it. The rule paid for
itself a second time on the raise to `THUMBNAIL_MAX_FLAT_BYTES`: every fish2 row the 2 MB ceiling
had blanked came back on the next reload, with nothing to purge.

**A blank tile says which kind of blank it is.** There are two, and until `readKey` was made to
tell 413 from 404 there was one: the dataset has no cheap geometry for this neuron — unmeshed,
full-resolution-only, a failed request — or it *has* a picture and the byte ceiling turned it
down. `DataSource.fetchCoarseGeometry` answers `undefined` for the first and a `CoarseRefusal`
for the second, and the tile's `Entry` carries `null` or `'too-large'` accordingly. Worth the
seam because on a flat mesh store the refusal is the **common** case rather than the rare one —
fish2's median body is 0.54 MB — and because the two are actionable in opposite directions:
nothing will ever make an unmeshed body draw, where a refused one is a picture a ceiling
declined.

**It differs in what it says, not in what it draws**, which is a decision rather than an
omission. At 56–76px there is no second glyph a reader could tell from the first without being
told what it meant — a badge at that size is a smudge — where the sentence fits in a `title` and
reads the same on both tile sizes. The refused one is also the only one **announced**: an empty
tile is decorative, saying what the row already says, so on a dataset that publishes no cheap
geometry at all every row would read out once more for nothing; a refusal is a fact carried on no
other surface. `data-blank="too-large"` is the hook the tests use, since the tooltip's prose is
the part most likely to be reworded and its wording proves nothing.

**Thumbnails are the coarsest published mesh, projected.** No token — meshes come from public
buckets, so they work in a static deploy where the Cypher API cannot reach. `thumbnail.ts` is
pure and returns a one-byte-per-pixel **coverage mask**, not RGBA: 9 kB rather than 36 kB, and
carrying no colour it survives a theme switch, which a cached tile with the theme baked in would
not. Triangles are filled and depth-shaded (brightest-wins, so overlapping branches do not
saturate); vertices alone would be a dotty cloud at that level of detail.

**Which sources have them is a question about what is cheap, not about backends.**
`fetchCoarseGeometry` is optional on `DataSource` and `undefined` means "draw a placeholder",
which for a source with nothing cheap is the honest answer rather than a gap: the alternative is a
page of 25 rows fetching several megabytes each. neuPrint's published buckets qualify; so does a
CAVE dataset whose materialization has a flat segmentation beside it (`DatastackSpec.flat` — see
[backends-cave-geometry.md](backends-cave-geometry.md)), which is what took FlyWire's rows from a placeholder apiece to a
drawing. `fetchCoarseMesh` in `precomputed/index.ts` is the one implementation both call, so the
byte ceiling and the "coarsest level" trick cannot be spelled two ways.

**`CoarseGeometry` is a union, because the second CAVE route answers a skeleton.** A datastack
with only its `graphene://` segmentation has no cheap mesh *at any level* — the cheapest mesh is
the only mesh, several hundred supervoxel fragments at full resolution — so a mesh-shaped seam
left BANC, MICrONS and every other chunkedgraph datastack with a placeholder in every row. Their
level-2 chunk graph is two small requests and enough to draw with, which is why the seam takes
either shape rather than making a source fake the other one: meshing a skeleton, or decimating a
mesh into a tree, is work done to satisfy a type rather than to draw a picture. `kind` is required
on both arms — inferring it from which field is present makes a source that forgot it a silent
fall-through to the mesh branch and an empty tile.

The cost is one neuron's worth of batching, knowingly. `readL2Skeletons` pools chunk ids across a
whole request, so a hundred skeletons is a hundred graph reads plus about three attribute reads;
`CoarseGeometryRequest` is one neuron, so a page of 25 is 25 plus 25. Widening the seam to a page
means a batching protocol between the component and every source, for a picture already gated at
four concurrent and cached in IndexedDB after the first look.

**CATMAID is the other source with only skeletons, and it is the expensive one.** It stores
tracing rather than a segmentation, so there is no mesh at any level either — and its skeletons
are traced rather than chunk-decomposed, which is a different order of size: measured against
VFB's FAFB, skeleton 16 is 940 kB and skeleton 2333007 is 4.2 MB, uncompressed. There is
deliberately no byte ceiling; see [backends-catmaid.md](backends-catmaid.md) for why one would blank the neurons
anybody is looking for. What makes it affordable is the IndexedDB mask — a thumbnail is fetched
**once per neuron ever**, not once per page turn.

**Two rasterisers, one `fitToTile`.** `rasteriseSilhouette` fills triangles; `rasteriseSkeleton`
strokes every non-root point to its parent, which is the same walk the SWC writer makes — so a
tree with several roots draws as several components rather than being joined through a fabricated
edge, and an out-of-range parent index is skipped rather than projecting `NaN` and striping the
tile. The shared fit is the load-bearing part rather than a tidiness: the padding, the one shared
scale that keeps aspect ratio, the image-space axes and the depth normalisation are the visual
identity, and two copies would drift on one of them and frame mesh rows and skeleton rows
differently in the same list.

**`STROKE_FRACTION` is 0.02, and both failure modes are real.** It is a fraction of the tile
rather than pixels, the same rule `padding` follows, so a skeleton drawn at two sizes is one
drawing — 6 raster pixels at the 304px raster behind a 76px tile, and 3 at the 152px raster it
was chosen against. Chosen by rasterising four BANC L2 skeletons and printing the mask as ASCII,
the only way to look at one outside a browser. Coverage on a 2,684-node descending neuron, at the
widths as they were then: **1 px → 3.3%**, and the descending axon is the faintest step of the
ramp and does not survive the downsample; **3 px → 6.6%**, arbor structure
and axon both legible; **5 px → 8.9%**, and the arbor fills in solid — a blob with a tail.

Re-checked on FAFB, since one constant now serves a ~1,300-node chunk-graph skeleton and a
16,840-node traced one — **thirteen times denser** — and it behaves the same way: at 1 px
skeleton 16's descending axon is the faintest ramp step again, at 3 px it is solid, and its
terminal tuft saturates at every width tried, so what saturates there is the arbor being genuinely
dense rather than the stroke being wide.

**Where a skeleton carries radii, 0.02 is the width of its p95 radius, not of every segment.**
A uniform stroke was reported as coarse on minnie65 and Aedes, where mouse and mosquito arbors
drawn at one width read as a tangle of equally thick rope. Two ways to use the radii were drawn
side by side on real minnie65 and BANC L2 skeletons at the tile raster, and the obvious one lost.
**At scale** — `max_dt_nm` as a width in the tile's own units — every segment but the soma lands
under two raster pixels (p95 radii 317–428 nm against arbors hundreds of microns across), so
the floor draws the whole neuron and the taper the radii carry is flattened out of it: hairlines,
which is what this paragraph used to record as the reason not to use radii at all. **Normalised**
— the 3D View's `radius` mode, widths proportional to radius with the p95 on `STROKE_FRACTION` —
keeps the trunk and soma as bold as the uniform stroke drew them and thins the twigs, which is
the picture. `strokeWidths` clamps to `STROKE_MIN_FRACTION` (2 raster pixels at 304, so a twig
still lands on a pixel) and to twice the p95 width (a minnie65 soma chunk reaches 6.2 µm against a
317 nm p95, and at scale that is a blot). A segment takes its endpoints' **mean** radius, a
missing one counting as zero, so a chunk too small to have `max_dt_nm` draws thin rather than
vanishing. Two properties `thumbnail.test.ts` pins: a skeleton of **one calibre draws
byte-identically to the uniform stroke**, so a list mixing radii and none reads as one renderer;
and **under half the drawn endpoints carrying a radius falls back to uniform**, which is
CATMAID's shape — a radius on the soma and nowhere else would otherwise scale every other segment
onto the floor. The change bumped `MASK_FORMAT`, since a stored mask does not say which rasteriser
drew it.

**`drawSegment` stamps along the major axis rather than filling a quad**, which is not the obvious
choice — a segment of a given width *is* a rectangle, and `fillTriangle` would take two. The
problem is that the rectangle is two or three pixels wide: a barycentric test samples a pixel
centre, so a thin diagonal quad drops pixels wherever no centre lands inside it, and the neurite
comes out dotted. Its `thickness` is a diameter, so an even width is honest rather than rounding
down to a single pixel the way a radius would.

**Rasterised at 4× the box it is drawn in** (`RASTER_SCALE`), because the mesh has more detail
than a 76px tile can hold — at 1:1 a thin neurite either landed on a pixel or vanished. The
browser downsamples, which is what turns the surplus samples into antialiasing, so
`image-rendering` must stay `auto`. The raster size is part of the cache key, so masks stored at
an older resolution are a miss rather than a tile at the wrong scale.

**It was 2×, and 2× is 1:1 on the screens this is used on.** A 76px tile at `devicePixelRatio` 2
is 152 device pixels, which is exactly what the 2× raster produced — so every HiDPI display was
getting no supersampling whatsoever, and only a 1× one ever saw the effect the constant existed
for. That is not visible as a bug; it looks like the constant working. Four restores 2×
supersampling on a Retina screen. It is deliberately **not** `devicePixelRatio`-derived: dpr
would enter the cache key, fragmenting the store across displays and re-fetching every neuron
when a window moves to another monitor.

What 4× costs, measured rather than reasoned:

- **Bytes, 4× again** — 90 kB per mask at a 76px tile against 23 kB, and 49 kB against 12 kB at
  Explore's 56px rows. `cache.ts` evicts nothing, so it accumulates until the Sources panel
  clears it: order 90 MB per thousand neurons browsed.
- **Rasterisation is not the constraint** — a 2,684-node skeleton 0.95 → 5.06 ms, a 310-node one
  0.16 → 0.83 ms, a 600-triangle mesh 0.20 → 0.64 ms; and the synthetic skeleton behind those
  numbers sits at 40% coverage where a real one is 3–12%, so they are ceilings. Behind
  `MAX_CONCURRENT` and two round trips it does not show.
- **One refetch of everything, once** — the raster size is in the key, so every mask stored at 2×
  misses and its geometry is fetched again. That is the actual price, and it is network.

It buys **no detail**: the geometry is coarse by construction and `STROKE_FRACTION` is a
fraction, so a skeleton's stroke is 6 raster pixels rather than 3 and lands at the same 1.5 CSS
pixels. Antialiasing is the entire product. The refusal floor is unaffected: it refuses only a mask
with **nothing** painted, which is zero at every scale.

**That floor was 0.002 of the tile, and it measured the wrong thing.** It was written to hide a
stray fragment behind a placeholder and argued from skeletons — four BANC ones at 3.3–11.7%, and
coverage flat across scales for one of them (0.399 / 0.413 / 0.406 / 0.418 at 112 / 152 / 224 /
304). But `fitToTile` scales every shape to fill the tile, so a fraction measures how *thin* a
shape is rather than how small or how broken, and a mesh of a long thin neuron has no stroke to
hold it up. Measured on `neuprint-fish2`, through the app's own fetch and rasteriser:

| population | n | coverage at 304 | under 0.002 |
|---|---|---|---|
| the smallest bodies (8–43 vertices) | 12 | 0.172 – 0.580 | 0 |
| random bodies | 49 | min 0.00083, p10 0.00180, p50 0.00834 | 5 |
| the two reported blanks | 2 | 0.00159, 0.00193 | 2 |

So it **never rejected a fragment** — those score highest — and blanked about one real neuron in
ten, each of which renders (drawn and looked at) as a soma and a long axon, faint and legible. It
also disagreed with itself across tile sizes: 100006807 is 0.00219 on the card's 224 raster and
0.00193 on the overlay's 304, so it drew on one surface and not the other. And it fell into the
unnamed blank, so the tooltip told the reader the dataset *published no geometry* for a body it had
just downloaded. What genuinely has nothing to draw rasterises to exactly zero, and
`thumbnail.test.ts` pins each case. A smaller number was the other option and was not taken:
nothing measured sits between zero and the thinnest real neuron (77 painted pixels at 304), so it
would be a threshold with no case under it — the same mistake at a lower value.

**The ink is `CHART_INK[mode].primary`, and the reason is the ramp rather than the near end.**
A silhouette is mostly *not* full coverage — `DEPTH_FLOOR` shades the far surfaces to 70/255 —
so most of a neuron is painted through an alpha well under one and the contrast a hex reaches on
its own is not the contrast on screen. Composited over each mode's tile (`--surface-3`), the
`secondary` ink this used to take was worse in light at every step of the ramp: 6.90:1 against
dark's 9.72:1 at full coverage, and **1.52:1 against 1.90:1 at the floor** — a fifth of the
contrast where the picture is faintest, on the mode that had less to give, which is the reported
"light grey on white". `primary` closes it: 17.1:1 against 17.4:1 near, and 1.88:1 at the floor
against dark's *previous* 1.90:1 — so the far end of a light thumbnail now reads exactly as the
dark one already did, which was the half said to look right. Doing it at paint rather than by
lifting `DEPTH_FLOOR` is what keeps every stored mask valid: the floor is baked into the coverage
bytes and would need `MASK_FORMAT` bumped, refetching geometry for every neuron anybody has ever
looked at.

**A thumbnail is the one surface where a stale theme does not heal, so it observes the flip.**
The mask carries no colour, so a theme change alters only which ink goes through it — but the
paint is an effect keyed on the mask, and nothing re-renders a row: Explore fetches for itself
and its rows subscribe to no graph state. The chart viewers read `currentMode()` during render
and go stale on a flip too, and there the next edit repaints them
([viewers-matrix.md](viewers-matrix.md) records that as pre-existing); here there is no next edit, so a list
rendered in dark mode kept `#c3c2b7` on a light card for as long as it stayed open — which is the
other, larger half of "too faint", and not about the palette at all. `useThemeMode` watches both
inputs, because the preference has three values and only two are stamped: `data-theme` carries an
explicit light or dark and is *absent* for `system`, where the OS media query is the whole answer.
It is local to `NeuronThumbnail.tsx` on the second-consumer rule; the viewers all want it, and
that is one lift rather than eleven. The test flips `data-theme` and asserts the second frame's
ink, recording `putImageData` for that one case — real RGBA bytes, not a transcript of calls into
the 2D stub, which is deliberately not a spy.

### The expanded row: columns, and marks

**The expanded view's width buys vertical scanning, and only alignment can spend it.** A chip that
is absent shifts every chip after it, so a row of twenty chips is *harder* to read than a row of
eight — you cannot run your eye down a column and compare, which is the one thing the extra width
was ever going to give. So the expanded row is a grid with a header, and the card keeps its chips.

**Which annotations get a column is measured, not curated.** `splitByFill` takes `rowFields`'
already-ranked candidates and keeps the ones filled on at least `FILL_MIN` of the dataset, up to
`MAX_COLUMNS`; the rest fall through to chips. That is the rule the two failure modes argue for:
`class` on male-CNS is on nearly every neuron and belongs in a column, where `dimorphism` is filled
only where it means anything and as a column would be a stripe of blanks eating width a filled
column wanted. As a chip it simply appears where it applies. **The inversion is the point** — an
absent chip says nothing, where an *empty cell* sits at the same position as every other value in
its column and says nobody annotated this one, which on an annotation-rich dataset is information.
Measured dataset-wide and strided (`FILL_SAMPLE`), never over the current hits, or the columns
would reshuffle as somebody types; and the fill rate is a *filter* on the priority order rather
than a re-ranking, since `type` before `class` before `superclass` is a hierarchy and sorting it by
completeness scrambles it.

**There was a `Fields` param, and the list the header edits replaced it.** It was the inspector's
pick of annotations, with a mode saying whether the pick was added to the automatic list or stood in
for it, and it survives in the history of this file for one lesson: once the header could place
fields, `Fields` had become three things at once and a complete account of none. It stored the
header's *chip* choices, which is why it looked out of sync with the row — it never listed a column
or an automatically chosen chip, only chips somebody had picked by hand; it was the **only** way to
configure a node card, which has no header; and it was the only way to *hide* a default field,
which is why "Remove column" had to be disabled for `class` with a title pointing at the inspector.
All three moved into the one list (`layout`: columns and `chip` entries), so the row, the header,
the `+` menu and the card read one thing and nothing can disagree. **Dropped outright, in beta**:
a stored `chips` or `fieldsMode` is now an undeclared param, which `normalizeParams` ignores, so a
saved workflow's hand-picked chips revert to the automatic ones with nothing said. Cosmetic rather
than a data loss — both were presentational, so no result moves and nothing re-runs — and none of
the repo's own workflows (the wizard, the demos, the Zoo) set either. Neuron Profile keeps its own
`Fields`: a different widget, untouched.

**The automatic list is capped by *colour*, so the expanded view can afford a longer one.**
`MAX_CHIPS` is eight because that is the palette, and an aligned column is plain text with no slot
at all — so the expanded view's cap is `MAX_COLUMNS + MAX_CHIPS`, the chip budget plus the columns
that never spend one. Without that the first eight candidates on a male-CNS-shaped schema are used
up by `class` through `cellBodyFiber`, and the annotation-rich tail is unreachable however
interesting it is: `dimorphism`, `fruDsx` and `exitNerve` were all candidates and none of them
could ever appear. The card keeps the eight, which is not an oversight — it is the narrow surface,
every annotation there *is* a coloured chip, and thirteen of them is not a row anybody can read.
`entryNerve` and `exitNerve` are two entries rather than one family for the reason `somaSide` and
`rootSide` are: a neuron does not leave by the nerve it entered through.

**Nothing here needed a new fetch except one thing.** `neuronIndex` is `findNeurons` with the
*discovered* schema, and discovery admits up to `MAX_EXTRA_COLUMNS` = 200 properties — so `size`,
`dimorphism`, `synonyms`, `fruDsx`, `itoleeHl`, `supertype`, the whole `superclass`→`class`→
`subclass` hierarchy and the neurotransmitter confidence are *already in the browser* as part of
the 26 MB index. Showing them costs layout. The exception is the region breakdown: `roiInfo` is
suppressed from the neuron schema as a kilobyte of JSON per neuron, so that one is a query — see
below.

**One template, three ways to get it wrong, all browser-only.** `rowTemplate` is shared by the
header and every row, and *every track but the name block is a fixed size*, which took three goes:
an `auto` track sizes to its own row's content, so the header — which has no checkbox and no tile —
collapsed its first two tracks and sat its labels 110px right of the values they named; the
trailing `auto` held the figures, whose width follows the digits (`400` against `1,496`), so a
row's own columns drifted against each other; and `minmax(0, 8rem)` let a column shrink by a
different amount per row. A mark's track is fixed for a fourth reason of its own: it is sized from
what the **column** draws, not from what the row has a value for, because a neuron missing `pre`
draws no balance bar and a track that shrank for it would pull that row's figures left of everybody
else's — and because the region bar arrives a query *after* the row, so a track that grew when it
landed would shift the page sideways as the fetch returned. Measured in a browser: header and values
at identical x on every track, before and after a column is added (`pnpm probe:explore-columns`).

**The header also lifted the figure labels out of the rows.** `pre` under twenty-five figures is
the same word twenty-five times down a column that already says it once.

### The header is editable: a column is fields plus a renderer

**The header was three mechanisms, and none of them could be edited where it was drawn.** Aligned
annotations came from `splitByFill`, the marks from `plotSpec`'s hard-coded pairs, the figures from
a fixed list capped at three. On `neuprint-fish2` that left four properties on every neuron —
`axonIn`, `axonOut`, `dendriteIn`, `dendriteOut`, present on 2,000 of 2,000 sampled — with no way
onto the row except as left-aligned text through the old `Fields` picker, since fish2 spends its three figures on
`pre`, `post` and `synweight`. So a column is now `ColumnSpec` — **one or more fields plus a
renderer** (`rowColumns.ts`) — and the three mechanisms survive as `automaticColumns`, in the order
the row always drew them. Nothing about the old marks was special: the pre/post balance bar was a
two-part stacked bar all along, and the size tick a one-field rank. One text field is text; one
number is a figure, a bar, a log bar or a rank; two to eight numbers are a stacked bar, bars side by
side, a donut, or a line of text.

**A merged column is a share of its parts' own sum, never of a column they are supposed to sum
to**, and that was measured rather than assumed. On fish2 `axonIn + dendriteIn` equals `post` on
2,000 of 2,000 neurons sampled, but `axonOut + dendriteOut` equals `pre` on only **722** —
100006807 has `pre` 86 and `axonOut` 94 — so a share of `pre` draws past the end of its own bar.
`sharesOf` is the pre/post rule generalised: all or nothing (a bar drawn from the parts that happen
to be present is not a split), `null` on a zero total and on a negative part. Parts are coloured by
position, so part one is one hue down the whole column, and capped at `MAX_PARTS` = the palette:
both marks *fold* past the eighth slot onto `Other`, which is right for a region's tail and wrong
where every part was chosen by name. A text field cannot be merged — ticking one swaps the
selection rather than refusing, since a share needs every part to be a count.

**Side-by-side bars are shares too, not the largest part scaled to full.** They exist for a
different question than the stacked bar — "how do the parts compare" rather than "which way does it
lean", since four stacked segments are four lengths from four starting points and four bars on one
baseline are not — but one height has to mean one fraction on every row, which is the property the
stacked bar's shared left edge buys. A part that exists is never zero pixels tall. **Merged text**
is `100 / 50`, each value in its own unit, and a missing value is a dash *in its own position*:
dropped, `— / 50` would read `50`, which is the same two fields saying something else.

**A column can be named**, and the name is the only thing about it that is not derived. The field's
placeholder is the automatic name, so empty reads as "automatic" rather than blank, and a name equal
to the automatic one is not stored — or the column stays pinned to a label that only happened to
match. A renamed header's `title` still names the fields, since the name no longer does. That
optional field is why an entry is a JSON **object** rather than the `[render, ...fields]` array it
started as: an array has no slot for an optional value that could not be mistaken for one more field.

**A figure prints its stored number unless it is asked for human-readable formatting** — `15417`
by default, `15.4K` with the box ticked. It was built the other way round first, readable by
default with an "Exact values" opt-out, and turned around on the argument that a field somebody
adds by hand is usually added to be read or copied as a value. So `readable` is the flag, off is its
absence, and the three ways a column appears decide it: **added** (`+`, a promoted chip, Combine)
is exact; the **automatic** figures carry `readable: true`, which is how they always drew and what
the first edit to a header writes for them, so editing one column changes no other column's digits;
and a node **card**'s figures stay readable, not being columns anybody configured. Exact is
`formatExact`, the rule the hover already used, in the column's **stored** unit — scaling a cable
length into millimetres is the half of the readable form that rounds. It applies only where a column
prints digits (one number, or merged numbers as text); a bar or a rank has none. An exact figure's
track is 6.5rem rather than 4.5rem — `2980158.182` in 11px mono is about 73px — and anything longer
is clipped with an ellipsis rather than spilling into the next column, the whole number staying in
the title.

**A bar reads against the whole column's maximum, not the sample's.** `distributionsFor` samples by
stride for the rank, where one neuron more or less moves nothing; the largest neuron in a dataset is
one row, which a stride of forty skips thirty-nine times in forty, and every neuron above the
sample's top would then draw full. One pass over a column per dataset is a millisecond. The log bar
is `log1p(v) / log1p(max)`, the heatmap's log.

**The first edit writes the whole list.** Automatic until touched, then stored — a list half
automatic and half hand-built would move by itself under the columns somebody placed. It is
`layout`, an `ids` param of JSON entries (`{"render":"stacked","fields":["axonIn","dendriteIn"]}`, JSON for
`paramPairs.ts`' reason: fish2 publishes `AF10_Tectum(L)`), **presentational** because only the
drawing reads it, and needing no `absentMeans` because empty, absent and the old behaviour are the
same answer. The inspector's read-and-clear field (labelled **Fields**) is the reset, and so is the editor's
`Reset to automatic fields`. Removing the last column is disabled rather than allowed, since writing an empty
list would read as asking for the automatic one back.

**The list outlives the dataset it was built on**, so `resolveLayout` asks each stored entry
whether it can be drawn here: a missing field, or a renderer that no longer fits its field's type,
keeps the column off the row — a merged one **whole**, since the parts that remain are a split of
something else under the same header. **Off the row, not out of the list**: what this dataset cannot
draw comes back as `unseen` and every edit writes it back verbatim, because `fits` deciding what is
kept as well as what is drawn meant a rename made while a graph pointed at hemibrain erased the
fish2 columns it was built with — the multi-column picker's "keep an unseen list untouched", arrived
at a second time. A list naming nothing this dataset has falls back to the automatic one rather than
drawing an empty header, and `explicit` says which answered. The tag column is excluded in the same
place, `fits` and `offerableFields`, since it draws as its own row. And the region query is
asked **only while a column draws it**: a header with the donut removed has no reader for the one
request on this surface that reaches a server.

**Once the list has been edited, a field is shown if and only if the list holds it — as a column or
as a chip.** The fill rule decides only until somebody has decided instead, and the first edit
writes the automatic columns *and* the automatic chips exactly as they were drawn, so nothing on
screen moves. It took three shapes. First the header held columns and `Fields` chose chips, so a
well-filled field added through `Fields` after the header was edited was classed a column by the
fill rule, was not in the stored list, and drew in **neither** place. Then "a column iff the header
holds it, every other shown field a chip", which fixed that and left `Fields` holding half the row.
Then one list. A confidence bar's label is not one of the fields it places, since the prediction is
a chip beside the bar that says how far to trust it. What the one list buys most visibly is
**hiding**: Remove column removes, clicking the highlighted half of a field's pair in the `+` menu
hides it, and so does "Hide" on a chip's right-click. The one refusal is an edit that would **empty** the list, since an empty list is the automatic
one and would bring every default back — asked of the edit's *result* (`isEmptyLayout`) by every
control that could produce it, so a refused click is a disabled control and never a silent one. A card draws the
list's text columns as chips ahead of its own chips, having no header to align them under; its
figures stay the automatic ones, a card being a summary rather than the table.

**The choice is made where a field is added.** The fill rule's weak point was sparse fields: they
became chips, and somebody who wanted one aligned had to find it on a row before they could promote
it. So the header's `+` lists **every** field with a `column | chip` pair (`AddFieldMenu`), the
pressed half being where it is now — which makes the menu a map of the whole row as well as the way
onto it, and is what stops one field being placed twice. It stays open, so four fields are four
clicks. Merging several into one column is a different question (which fields, drawn how) and keeps
its own editor behind "Combine several fields…". The other two gestures are the reverse directions:
**right-click a chip** on a row for "Show … as a column" (the chip is where a field somebody wants
aligned is visible), and **"Show as chip instead"** in a one-field column's menu.

**Editing is a header cell and a `+`, not dragging one header onto another.** Drag-to-merge was the
other shape, and it cannot reach a field the header does not already show — which on fish2 is all
four of the fields the feature exists for. One `ColumnEditor` serves a header cell and the `+` menu's
"Combine…", since adding is editing a column that does not exist yet: a filterable field list, the renderers that can draw what is ticked,
and the tick order kept and shown because it is the order the parts draw in. **A draft until
Apply**, because every write is a param write and an undo step, and four ticks live would be three
steps describing a column nobody wanted. It is a `ContextMenu`, so Escape closes it
rather than the overlay (`useOverlayEscape`'s stack), and every key stops at it: the canvas binds
Space and Backspace, which a field filter is somewhere people type. **Only its field list may give up
height**: a flex column under a `max-height` lets every child shrink, and the caption's
`overflow: hidden` makes its automatic minimum zero, so on fish2's thirty-five fields the filter box
sat over the title. The mock's six fields fit and could not show it; capping the open editor at
300px does, and measured the caption at 8px of its 24 before `flex-shrink: 0` on the rest.

Measured in a browser on the demo workflow at 1600 × 1000 (`pnpm probe:explore-columns`), before the
`+` became a field menu, then re-run after: six
automatic labels at identical x and width to both the first and last row's cells, seven after a
merged donut is added; the add editor 264 × 266, wholly inside the window and hit-tested at its own
centre through `.overlay__panel`'s `overflow: hidden`; a column's editor 4px below the cell that
opened it, at its left edge; Escape closing the editor and leaving the overlay. **Not measured on
fish2 itself**, which needs a token in the browser — the four columns are the component tests'
fixture shape instead.

### The inline marks

Four, and three of them cost nothing because Explore already holds the whole table. **The balance
bar** is `pre` against `post` as one split bar with a shared left baseline — the proportion is what
varies down the column, where a centred diverging mark would make the *total* vary and the figures
already say that. Both or neither: a bar drawn from one half would read as entirely presynaptic,
which is a claim the data did not make. **The percentile tick** shows where a neuron sits in its
dataset's own spread, which nothing else in Coda can do cheaply — no other surface holds the
column, so nowhere else could answer without a query. A track with a tick and not a filled bar,
because a filled bar reads as a quantity and this is a rank. **The confidence bar** is drawn only
where the dataset publishes a confidence *and* the prediction it qualifies, and goes achromatic
below `LOW`: a weak prediction should not look like a category.

**The region mark is a donut, and the one that reaches a server.** A ring rather than a pie
because the slices are small: a pie's segments all meet at the centre, where the three narrowest
are a few pixels of shared point, while a ring gives every segment the same radial thickness
however thin its arc. Drawn as **dash offsets on one circle, not `A` path arcs**, and that is not a
style choice — a segment covering the whole ring is a 360° arc whose start and end coincide, which
SVG draws as *nothing*, and a neuron wholly within one region is the ordinary case for a fragment
rather than an edge case. Offsets accumulate rather than being computed per segment, so rounding
cannot open a hairline gap between two arcs meant to touch. It occupies a `MARK_W` track like every
other mark, centred, so `rowTemplate` never learns about a mark of its own shape — and it is the
same ring a merged column draws as a donut (`ShareRing`), coloured by part rather than by region.

Two rules decide whether it means anything. `roiInfo` nests — a synapse in `LO(R)` is counted again in `OL(R)` — so only the primary
set may be summed, and an *absent* primary list is not an empty one: it means discovery has not
answered, and `regionShares` then draws nothing rather than a plausible picture built on a total
nobody could reproduce. And the regions are **ranked across the page, not per row**: a bar whose
first segment is `ME(R)` on one line and `LO(L)` on the next is five colours meaning five different
things per row, which is worse than no bar. The tail folds into one `other` segment rather than
being dropped — a bar whose segments did not sum to the neuron's synapses would be a proportion of
nothing in particular, and **fold where the mark folds** is `colors.ts`' rule for exactly this
shape — and a ring folds. `useRowRois` fetches a page at a time in one round trip, settled and cached by the page's
own ids, and a missing `capabilities.roiCounts` is a missing mark rather than a broken list — every
other field on the row came out of the index and is perfectly good.

**Each mark is labelled in the header, as a column of its own.** Four small bars are unreadable
otherwise, and a `title` per mark only helps somebody who already suspects there is something to
hover. The marks used to share one track, with a row of labels laid out on their pitch and matched
to them by position — three parallel enumerations agreeing by inspection. As tracks of their own the
label is simply the cell above, and that machinery (`markSlots`, `--mark-gap`, `--mark-pad`) is
gone.

### A rest on a mark opens it larger, with its numbers

A 54-pixel mark is a scanning aid, and the moment somebody stops on one they want what it cannot say
at that size — which colour is which part, what the counts are, what "the dataset" a rank is read
against looks like. So a rest on any mark opens `MarkPreview.tsx`'s panel beside it, and what it
holds depends on what kind of mark it is:

- **A split** — stacked, side by side, donut, regions — is **the same drawing, larger**, above a
  legend of name, count and share with swatches in the row's colours. The same *components*, sized
  by a prop, never a second rendering: a figure that explains a mark is a copy of the mark, and a
  copy goes stale silently. The ring's stroke keeps its proportion to the diameter, so the preview
  is the row's ring rather than a thinner one with a bigger hole. A merged column's foot reads
  **"Sum of these"**, because the shares are of the parts' own sum (`sharesOf`) and on fish2 that
  is not `pre` on 1278 of 2000 neurons.
- **A bar or a rank** is the neuron against **the whole column**: a histogram of every row, this
  neuron's value marked and every bin to its left filled, so the filled area is the fraction a rank
  reports. It is the picture a rank *means*, and the one thing here no other surface can draw
  without a query, Explore already holding the column. **Every row, not the strided sample** the
  rank reads, for `Distributions.max`'s reason: a sample drops the dataset's largest neuron — one
  row — thirty-nine times in forty. Binned once per column and axis, memoised on the column array's
  identity, so a search or a page turn reuses it. A **bar's axis is the bar's own** — from zero,
  linear or log as the bar is — or the bar's zero would sit off the histogram's left edge. A **rank
  has no scale of its own**, so `spreadOf`'s `auto` axis reads the column: log where more than
  half of it falls in the first tenth of a linear axis, which at forty bins is the first four — the
  picture of a synapse count on a linear axis, with the neuron being asked about in the spike. It
  is decided from the linear binning of every row, not from the rank's sample, so one picture has
  one source. A column with a negative value stays linear. The log is the heatmap's own
  `normalize`, `log1p(v − lo) / log1p(hi − lo)`, called rather than restated, and the axis says
  "log scale" when it is one. The type is `Spread` and not `histogramBins.ts`' `Histogram`, whose
  log is `log10` over positive values only — right for a chart's axis, wrong against a mark.
- **A confidence** is its bar enlarged beside the prediction it qualifies, and a grey one says why
  it is grey.

**The regions ring itemises its `Other`.** The ring folds its tail and so does its legend — a sixth
colour would have to mean one region on this row and another on the next — but grey names beneath
the legend are not a mark, and the tail is exactly what somebody hovering a ring with a large grey
slice wants. `regionShares` hands the fold's members over on the `Other` segment
(`RegionShare.folded`), **ordered by this neuron** rather than by the page, since nothing in the
list is coloured and so nothing has to agree down the column. Eight are named, the rest counted.

**The marks lost their `<title>`**, which is the preview's doing: the browser shows one about a
second after the pointer stops, so with a panel opening at a quarter of that the native tooltip
arrived *on top* of it, saying less. The numbers are in the `aria-label`, and the panel is
`aria-hidden` for the thumbnail preview's reason — only a mouse can open it.

Four decisions about the gesture. **`HOVER_DELAY_MS.dense`, the port preview's 260ms rather than
the thumbnail's `sparse` 130**, and for the port's reason: marks are a dense grid, several to a row,
and a pointer on the way to one crosses others. The two delays are named once in `useHoverPanel.ts`
with that reasoning, the panels' chrome is one `.hover-panel` class, and every panel is kept inside
`layoutViewport()` — the thumbnail had been measuring `window.innerWidth`, which `menu/placement.ts`
records as wrong. **The cell is the target, not the ink** — a ring is 22 pixels of a 54-pixel
track and a bar 8 pixels tall, and a target that is only the ink is one a resting pointer slides
off. **It opens right**, the thumbnail's rule turned round rather than broken: open into what the
reader is not comparing against, which for a mark is the same column on the rows above and below
and the row's own name to its left. Clamped at the window's edge, never flipped. And **the state is
per cell**, since a hovered-cell id in the list would re-render a memoised page to change one row.
The panel's height is its content, so it is measured and then placed — `usePlacedPanel`, which the
port preview had written privately and now shares. Whether it lands whole, on top and at screen
scale is `pnpm probe:explore-columns`.

**Right-clicking a row opens a menu, and it wears `NodeContextMenu`'s clothes rather than its
own.** `ContextMenu` and `.context-menu`'s rows — a right-click should
not look like a different kind of thing depending on which surface it landed on, which is the rule
`NetworkContextMenu` already follows. Two things come free from that: the menu is on
`useOverlayEscape`'s stack above the overlay, so Escape closes the menu rather than the whole
overlay; and the menu is `position: fixed` in client coordinates,
clamped, because it belongs to the pointer rather than to the list that would clip it.

**Copy is two rows, which is where it departs from the network menu on purpose.** There, a
right-click *inside* the selection acts on the whole selection and one outside it acts on the mark
alone — right for a canvas, where the selection is an outline visible under the pointer. Here the
selection is a column of ticks that may be scrolled off screen entirely, so one gesture would
silently copy one id or four hundred depending on something the reader cannot see. `Copy ID` and
`Copy selected N` are always both drawn, the second disabled when nothing is ticked rather than
hidden, so the menu keeps its height between two right-clicks. Ids join through **`joinIds`'** own
default, so this and the Copy IDs node cannot put ids on a clipboard two different ways, and the
write is `ui/export.ts`'s `copyText` — the one place that knows the API is absent in jsdom and on
any non-secure origin.

**The type-shaped rows act on the index, never on the page.** `Select all of this type` ticks every
*hit* sharing the row's type; a version that took the visible rows would look right on a small
dataset and be silently wrong on every real one, since the page is only where you stopped
scrolling. The count rides in the row's `kbd` slot so the number is visible before it is committed
to — a selection travels in every downstream cache key — and it shares `selectMatching` with the
foot's Select-all, so the two cannot disagree about when a selection is worth warning about. The
scan is a `useMemo` keyed on the open menu rather than on every render: it walks every hit, which
is 165,122 rows on male-CNS, and once per right-click is nothing where once per keystroke would not
be.

**A right-click dismisses the hover preview, and that is a stacking fact rather than a courtesy.**
The preview is `z-index: 65` and `.context-menu` is 45, so a preview left up sits *over* the menu it
was opened from. Dismissing rather than restacking, because a right-click has finished with the
transient thing a hover put on screen whether or not a menu follows. Verified in a browser: the
preview is up before the press and gone after.

**Clicking through pages used to make the page you stopped on load last.** The queue behind
`MAX_CONCURRENT` was a plain FIFO, which is the right shape only if every waiter is equally
wanted — and while somebody clicks through pages hunting for a row, they are not. Five pages is
125 queued bodies with the screenful actually in front of the reader at the *back* of them, so it
filled after a hundred requests for rows that had scrolled away several clicks earlier. It reads
as the widget being slow; it is the widget being polite in the wrong order.

**Newest batch first, insertion order within it**, and both halves are load-bearing: serving the
newest batch fixes the across-page problem, and a plain `queue.pop()` would fix that while
reversing the rows *within* a page, so a screenful would fill bottom-up. A batch is a counter
advanced on a microtask, so nothing here has to know what a page is — React runs a commit's
effects in one synchronous pass, so every row of a page asks before control returns to the event
loop. Captured at the *top* of the loader rather than at `acquire`, because by then a row has
awaited an IndexedDB read and its neighbours are scattered across ticks; that capture point is
not pinned by a test and cannot easily be, since under jsdom the read resolves fast enough that
either place passes. A hover preview asks later than the page it is over, so it outranks it —
which is right, and falls out rather than being special-cased.

**What this does not do is cancel.** The pages clicked past still load, behind the visible one,
and they are not wasted: the mask cache is what makes paging back instant. The region query needs
none of this — `useRowRois` is settled at 180 ms, so pages clicked through never ask at all and
only the one the reader rests on does.

**The semaphore is module state, so the test seam resets it too.** A case that leaves a fetch in
flight holds its slot for every case after it, and the next suite's thumbnails queue behind a
request nobody can resolve — which is how the second of these tests failed before
`resetThumbnailCache` learned about `active` and `queue`.

**Hover enlarges a thumbnail, and past a point that means asking the source for a finer body.**
The first version was free: `RASTER_SCALE` rasterises at `size * 4`, so behind a 76px tile there
is a 304px mask and the downscale throws three quarters of it away — drawing that same mask at
176px is the detail the tile could not hold, at no fetch and no new cache key. That ceiling is
where it stopped, and it is the wrong place to stop, because there is a second knob one layer
down.

**`fetchCoarseMesh` had `triangleBudget: 1` hardcoded, and a budget of one is how `chooseLod` is
asked for the coarsest level** — there is no "coarsest" argument, only a budget no level can meet.
Raising it therefore asks for a genuinely finer body from the same pyramid, which is what
`CoarseGeometryRequest.detail` now carries. Measured against hemibrain's real pyramid
(2.0 MB / 280 kB / 48 kB / 11 kB), `PREVIEW_TRIANGLE_BUDGET` of 150,000 triangles is a ~255 kB
allowance and moves LOD 3 → **LOD 2**: one step, about 28k triangles against 11 kB's worth. One and
not two on purpose — LOD 1 is a quarter of a megabyte per hover for a difference a 320px picture
cannot resolve.

**It is a budget, not a promise, and the two sources that ignore it are answering correctly.** A
published mesh pyramid has levels to trade against. CAVE's `graphene://` route answers a level-2
chunk skeleton whose resolution is a property of the chunk graph, and CATMAID already returns the
whole traced arbor — for those two there is nothing finer in existence and the enlargement is the
raster alone. Which is why the preview *falls back* rather than waiting: `fine === null` is the
ordinary answer on two of the four routes, and the tile's own mask stays up forever there.

**The preview opens on the tile's mask and swaps when the finer one lands, at one size
throughout.** Drawing the stand-in at its natural 304 and the replacement at 640 would change the
box when the fetch returned, which reads as the picture jumping rather than sharpening — so the
stand-in is knowingly upscaled 5% for as long as it is up. Confirmed on a cold cache in a browser:
`304@320px → 640@320px`. The fine fetch is started **when the preview opens**, never on pointer
arrival, so a sweep down 25 rows is 25 pointerenters and no requests at all.

**`PREVIEW_RASTER` is 640 and deliberately not `PREVIEW_SIZE * RASTER_SCALE`.** Four times a 320px
box is 1280², 1.6 MB per mask against the tile's 90 kB. 640² is *exactly* native at
`devicePixelRatio` 2, 2× supersampled at 1×, and 400 KiB. The tile needs four because its problem
is a hairline neurite landing on one pixel or none at a size where the geometry outruns the raster;
at 320px that inversion is over and the detail comes from the finer body instead.

**A tile's mask is cached; the preview's is not, because it is derived.** The preview's mask and
its sweep both come from one `loadFineGeometry`, so the mask is
`silhouetteOf(geometry, PREVIEW_RASTER)` — a pure function of state the component already holds.
That was not obvious at first, and holding it as a *second detail level inside the tile cache* cost
a second cache namespace, a `persists()` predicate consulted at four sites, a second eviction
policy with its own 24-entry cap, and a branch on the concurrency semaphore. All of it was
bookkeeping around a derived value; deriving it deleted the lot and left `loadSilhouette`
single-purpose. **The bound moved down a layer with it**: the body is the only thing worth capping
(`MAX_FINE_GEOMETRY`, 3, through `keyedCache`), since the mask is one rasterisation away from it.

**And the still picture is only drawn where there will be no motion.** The centre frame arrives one
build tick after the body does, so rasterising a static mask first *delays* the sharp picture by
exactly its own cost — 28 ms on a decimated arbor — to show something for one frame that the rock
then replaces. Under `prefers-reduced-motion` there is no rock and it is the whole feature. So the
preview has three sources in order of what they know — the frame the rock is on, the still picture
where there will be none, and the tile's own mask enlarged — and the last is not a failure state:
on CATMAID and CAVE's chunk-graph route there is nothing finer in existence, so the tile's mask
*is* the honest picture.

**Caches are not ceilings unless the rows let go.** `ExploreBody` renders a whole page at once and
the body is per-row React state, so a hovered row held its ~0.5 MB geometry for as long as the page
stayed mounted — evicting from `fineGeometry` frees nothing while the row that fetched it still
points at it. Measured against the declared bound, a page of 25 hovered rows overshot
`MAX_FINE_GEOMETRY` **eight-fold**. `hide()` drops both references; they re-resolve from the cache
in one microtask on the next hover, and where they have been evicted that is exactly what the cap
was for.

**The paint is one buffer, and it is a layout effect.** An `ImageData` wraps its array rather than
copying it, so writing the buffer is writing the image; the ink is filled only when the theme
moves and the coverage on every frame, which at 640² is 0.303 ms against 0.695 for all four
channels — 3.9 ms/s against 8.7 at the rock's 13 repaints a second. `useLayoutEffect` rather than
`useEffect` because assigning `width` or `height` **clears a canvas**, and React commits that before
a passive effect runs: seen in a browser, the swap from the 304px stand-in to the sweep's first
640px frame sampled at *zero* coverage for one frame.

**`PREVIEW_SIZE` is 320 because that is the largest that still clears the row on a 1920 screen**,
which is measured and not chosen. Box edges include the 6px padding and 1px border:

| window | tile | row name at | preview box | covers the name |
| --- | --- | --- | --- | --- |
| 1920 | 268..344 | 351 | 8..342 | no |
| 1440 | 86..162 | 169 | 8..342 | yes, by 173px |
| 1100 | 86..162 | 169 | 8..342 | yes, by 173px |

The panel is centred under a 1500px cap, so at 1920 the gutter plus the tile's own column is 344px
and a 334px box fits with 9px to spare; one step larger starts covering the name there. **Below
1440 it covers whatever its size** — the name begins 169px in and nothing wider than ~147px clears
it, so the 176 this replaced already covered by 21px. The choice at those widths is between
covering 173px and covering 21px, against a picture 4.2× the tile rather than 2.3×. 232 takes the
other side; there is no size that avoids the trade.

**It runs on a node card too, and the objection that kept it off turned out to be already
answered.** It was the overlay's alone on two counts: a card's tile is 56px against a 224px mask,
and inside a card the preview has `.coda-node`'s clip to escape as well as the list's, from inside
React Flow's *transformed* pane — which is the interesting half, a `transform` being what makes an
ancestor the containing block for `position: fixed`. But the portal already goes to
`document.fullscreenElement ?? document.body`, which has no transformed ancestor, and
`getBoundingClientRect` reports viewport coordinates through one. So the machinery the overlay
needed is the machinery a card needs, and neither clip was ever in the way.

Measured rather than argued, since every word of it is about layout and jsdom performs none —
`pnpm probe:explore-preview`, on a card at the demo workflow's own 0.452 pane zoom:

| | tile | preview box | canvas | hit-tested at its centre |
|---|---|---|---|---|
| card, 0.452× pane | 25×25 at 1200,556 (56 unscaled) | 334×334 at 870,409 | 320px | `canvas.explore-thumb-preview__canvas` |
| overlay, 1600px | 76×76 at 108,187 | 334×334 at 8,65 (clamped) | 320px | `canvas.explore-thumb-preview__canvas` |

320 and not 145 is the transform question answered; the hit test is the clip question, and it has
to lift `pointer-events` to mean anything — the preview declares `none` so the list stays drivable
underneath it, and the first run of that probe reported a `td` in another card, which reads
exactly like a clip.

**What compact really costs is the stand-in, and only until the fine body lands.** The tile's own
mask is `56 × RASTER_SCALE` = 224 against the overlay's 304, so the picture held up in the meantime
is upscaled 1.43× rather than 1.05×. The settled picture is identical on both surfaces — a 640
raster drawn at `PREVIEW_SIZE`, off a body neither tile fetched — which is the last column of the
table. The 176-versus-130 arithmetic the gate rested on was written before `detail: 'fine'` existed
and stopped being true when it did.

The prop's default stays `false`, and that is for the other caller rather than for the card:
`ProfileViewer`'s shape tile stands for a *group* by drawing its first member, so an enlargement
there would offer a closer look at a neuron the header is not about.

**Three clips and a portal.** `.explore__list` is `overflow-y: auto`, which clips the *other* axis
too, and `.overlay__panel` is `overflow: hidden` — so an in-place enlargement is cut off at the
left edge and at both scroll edges, and growing the tile in flow would break the rule the row is
built around (every row the same height is what makes a list scannable). Hence a portal, and
`position: fixed` is right here for exactly the reason `.chart-tooltip` says it is wrong there: a
portal has no transformed ancestor, so viewport coordinates mean what they say. The third clip is
the silent one — `.overlay__panel:fullscreen` becomes the fullscreen root, and the top layer shows
that element's subtree and nothing else, so a preview portalled to `body` would be built,
positioned correctly and **invisible**. The host is `document.fullscreenElement ?? document.body`,
read off the document rather than off the ⛶ click for the reason [ui-shell.md](ui-shell.md)
records: Escape and F11 both leave fullscreen without passing through this app.

**It opens left, which is the opposite of a submenu's rule, and the reason is what is behind
it.** The preview is a picture of the row the pointer is on, and that row's name, chips and
figures are all to the *right* of the thumbnail — opening rightwards covers the thing being
compared against. To the left is the checkbox gutter and then backdrop. `previewPlacement` is a
pure function over rectangles for the same reason `submenuPlacement` is: jsdom performs no layout
and reports one rect for every element, so a placement decided inside an effect has no coverage at
all. The arithmetic under it is `hoverPlacement`, shared with the output port preview, which
prefers the *other* side for the same reason this one prefers this side — see
[canvas-wiring.md](canvas-wiring.md); what stays here is the measurement that picks the side.

**The right-hand fallback was built, measured and deleted, and that is the finding.** It existed
on sound-looking reasoning — the panel is centred with 28px of padding, so a 1440px window has no
190px gutter to open into and needs a real second answer. Driven in a browser it does the exact
thing the left preference exists to prevent: at 1440 the tile sits 85px in, the fallback lands at
**171**, and the preview covers the hovered row's own name *and* the two rows either side.
Clamping to the left margin instead lands it at **8** — over the tile and the checkbox, clear of
every row's text. It is not close at any width, which is why the branch is gone rather than
reordered: text begins at the tile's right edge, so a clamped-left preview covers
`MARGIN + size - tile.right` of it (23px here) against a right-hand one's whole 176. The right
answer only starts winning if the thumbnail moves to the right-hand end of the row, and it is then
not a fallback — `tile.left - GAP - size` fits outright and the function already returns it. What
survives from that version is `covers`, the property the whole rule trades and the one a test can
assert without a browser.


**Four event rules, three of them found by asking what closes it.** They live in
`useHoverPanel` now, shared with the output port preview, which is where the arguments below were
re-derived and then extracted — see [canvas-wiring.md](canvas-wiring.md). A **130 ms** delay, or a pointer swept
down 25 rows opens 25 previews and the list reads as flashing. **Mouse only** — a tap synthesises
`pointerenter` too and there is no gesture that would close it. **The tile moving
dismisses it** — see below. And the hover state is **local to the thumbnail**: a `hoveredId` on
`ExploreBody` buys back the exact bug `NeuronRow`'s `memo` exists for, one pointer move
re-rendering twenty-five rows to change one.

**The dismissal is a watch on the rect, not a list of the events that can move one.** It was
`scroll` in the capture phase, which is right for the overlay and only there: `.explore__list` is
the one thing that moves and `scroll` does not bubble out of it. On a node card *nothing scrolls*
— React Flow pans and zooms by writing a `transform` onto the pane, so the tile slides out from
under the pointer having fired no event at all, and the preview is left hanging beside where the
row used to be. Adding `wheel` and `pointerdown` beside `scroll` would have covered those two
while still missing a keyboard fit-view, a resize, an auto-layout pass, a row re-flowed by a
search. So the property is asked directly: the placement was measured against a rect
(`previewPlacement`) and must not outlive it, which is one `getBoundingClientRect` per frame while
a preview is open — at most one at a time, against layout the rock leaves clean by painting a
canvas. A pixel of tolerance, because a card on a scaled pane lands on fractional coordinates.

Dismissing rather than repositioning is the half that predates it: once the list has moved, the
tile under the pointer is a different neuron, and a preview following the pointer down a scrolling
list is the strobe the delay exists to prevent. The right-click dismissal stays an *event*,
because it is about stacking rather than movement — the preview is `z-index: 65` against
`.context-menu`'s 45. **jsdom can still see the watch**, which is why it is not browser-only
coverage: the stub reports one constant rect for every element, so the test makes *that tile*
answer differently, which is the whole mechanism. Panning the canvas is the case only the probe
can reach.

### The rocking preview

**A neuron turns about its own centre, not the volume's origin.** `rotateY` took no pivot at
first, which means the world origin — and positions are nanometres in *dataset* space, so a neuron
sits hundreds of microns away from it. The result swings the neuron round an enormous arc instead
of turning it in place, and because `sweptBounds` then has to cover the whole arc, the fit shrinks
it to a smudge sliding across the tile. Measured in a browser, fixing it took the painted area from
7.2–7.7k pixels to 10.6–27.8k. `pivotOf` is the **bounding-box centre** of two defensible answers:
a vertex centroid is mass-weighted, so it sits inside whichever part is most densely tessellated
and turning about it leaves that part still while the long axon sweeps hardest — asymmetric, and
wider through the sweep. The box centre keeps the motion even and `sweptBounds` tightest, so the
neuron is drawn as large as the tile allows. Swapping it is one function.

**The rock starts on the thumbnail's own view and departs from it both ways.** `rockFrame` is a
sine from the middle, which is two decisions at once. It begins at the centre frame — the
unrotated one the static picture already shows — where a ping-pong from phase 0 begins at frame 0,
i.e. the −45° extreme, so the animation cut to the far side and travelled back. And a sine *is* an
eased ping-pong: it slows at each turning point, where a linear triangle reverses instantly and
reads as a judder. The shape it replaced needed a `pingPong` and a smoothstep to get half of that
and still started at an end. `ROTATION_FRAMES` is **odd** so there is a frame at exactly 0°; at 16
the nearest sit at ±2.8° and the rock would open on a view that is visibly not the static picture.

**Frames are built centre-first, because the framing has to settle once and early.** A sweep is
framed by `sweptBounds` and the static mask by its own bounds, and a rotating body needs more room
than a still one — measured, 1.6× smaller linearly and 2.6× the painted area once it turns. So
`buildOrder` puts the frame the rock opens on first and it replaces the static mask as soon as it
exists: measured in a browser, the static framing is up for **one animation frame, ~16 ms**, and
from there to the rock there is no change at all. Built left to right instead, the first frame shown
would be −45° — a change of framing *and* a jump to the far extreme.

**A resting pointer sweeps the neuron ±45° about the vertical screen axis.** A silhouette is a
projection, and the one thing a projection cannot show is which of two crossing neurites is in
front; `DEPTH_FLOOR` shades for it, which reads as *some* depth but not as structure. Motion
parallax does. About the **vertical** axis specifically, because horizontal parallax is the
component the visual system uses for depth — a nod about the horizontal also foreshortens the long
descending axon that is usually the thing being looked at. 17 frames across the 90°, 5.6° a step, played
**there and back**, so one sweep's worth of masks buys a whole cycle where a 360° turntable would
need every frame.

**Frames are transient and the geometry is cached — the inversion is the design.** Sixteen 640²
masks are 6.3 MB and take ~22 ms to rasterise from a mesh: cheap to rebuild, expensive to keep. The
body behind them is ~0.5 MB and cost a network round trip. So `fineGeometry` holds three neurons'
geometry and the frames live only while the pointer is on the row, freed when the preview closes.
Both the still picture and the sweep come from one `loadFineGeometry`, which is what stops them
being two requests for one body — and, once the mask became a derived value rather than a second
cached one, what stops the two from ever disagreeing about which body they drew. Memory only, so a
preview does not survive a reload and neither does what it is drawn from.

**Two things the static path could ignore.** `fitToTile` derives its box from the positions handed
to it, so a per-frame fit re-frames each rotated copy to its own bounds and the neuron **pulses**
as it turns — and its depth ramp breathes with it, since the same box normalises z. `sweptBounds`
computes one box over every angle that will be drawn and every frame goes through it; the
rasterisers take an optional box rather than this module owning a second projection, because the
fit is where the visual identity lives and two of them drift. `rotation.test.ts` pins it by
measuring the drawn vertical extent across the sweep and asserting it takes exactly one value.

**An order-independent ancestor walk, because `parents[i] < i` is not universal.**
Decimation reparents a kept node onto its nearest kept ancestor, which is the first thing in this
area to walk a parent *chain* — `rasteriseSkeleton` only ever draws `i → parents[i]`, one hop, so
it was immune. `spanningForest` guarantees a parent precedes its child for CAVE's L2 skeletons and
the precomputed ones, but **CATMAID's `decodeCompactSkeleton` does not go through it** and maps the
server's own node order straight across, so a parent may appear after its child — on exactly the
route decimation exists for. A malformed skeleton with a cycle is the failure
`data/skeletonTree.ts` exists to prevent and here it would hang the tab, so the walk
(`resolveUp`) is memoised and detects a loop exactly.

**It was capped at 64 steps instead, and the cap broke the drawing.** A long run of dropped nodes
is legitimate, and past the cap a kept node became a root — a break in the neurite, on the hover
preview only, since the tile is never decimated and neither is the 3D View. What made such runs
happen was the second half of the bug: nodes were thinned by a running quota over the **index**,
and a breadth-first node order puts one run's consecutive nodes a frontier apart in the array, so
where the frontier width lines up with the stride the same run is skipped again and again. Found
on minnie65 864691136108938168's service skeleton — 8,574 nodes, stride 3.0, six pieces. Thinning
is now **along each run**, from its position counted off the structural node above it, which caps
the gap at one stride and the total at the budget; the same skeleton comes back in one piece at
2,872 nodes in 2.7 ms. `rotation.test.ts` builds the breadth-first case, which failed with 11
pieces before.

**Decimation bought 2.7×, and then the rasteriser stopped wasting the other 5×.** The cap was
chosen against a measurement of 76.5 ms a frame undecimated and 28.0 decimated on a 16,840-node
arbor at 640², and the conclusion recorded here was that the remainder was fill whose only lever
was the raster. That was wrong, and finding out why is the useful part: `drawSegment` re-stamped
the whole `thickness × thickness` square at every pixel step, where the walk advances at most one
pixel per axis — 169 writes per step at the preview raster of which about 13 were new. Marking only
the newly covered edge is **byte-identical** (`value` is constant within a segment and `markPixel`
keeps the larger, so every skipped write was already a no-op; verified over 7,200 random segments
across three raster sizes and six thicknesses) and takes a sweep from 357 ms to 70.

With that gone the cap buys almost nothing: **4.8 ms a frame undecimated against 4.7 decimated**,
because the cost is the drawn path and thinning a run conserves it. Decimation stays — the mask and
the sweep must be drawn from one body — but nobody should expect a lower cap to buy frame time, and
`BUILD_BUDGET_MS` finally means something now that a frame fits inside it rather than overrunning
both the budget and the 16.7 ms deadline on every tick.

**Built against a time budget, not a frame count.** The two ends of the range differ by twenty
times, so `BUILD_BUDGET_MS` (8 ms) decides how long a tick lasts and the frame count follows: a mesh
finishes in three ticks, a decimated arbor in sixteen. At least one frame per tick regardless, or a
frame more expensive than the whole budget never finishes — which is the dense case, where each 28 ms
frame overruns a tick on its own. The preview shows the static mask throughout, so a slow build is a
picture that starts moving a moment later rather than an empty box.

**Nothing is built under `prefers-reduced-motion`** — not built-and-not-played. The frames *are* the
cost, and a reader who asked for less motion should not pay for an animation they will not see.

**The sweep crossfades in over the static picture, covering two real discontinuities.** It is framed
by `sweptBounds` where the static mask is framed by its own, so the neuron is drawn slightly smaller
once it turns; and a dense skeleton is decimated for the sweep and not for the mask. Both are right
on their own side, and neither survives a hard cut.

**How all of that was measured, since none of it is in the suite.** A throwaway page mounting real
`NeuronRow`s against the mock source inside a reproduction of the two clips (`.overlay__panel`'s
`overflow: hidden`, `.explore__list`'s `overflow-y: auto`), driven over the DevTools protocol the
way `scripts/probe-mobile.mjs` drives the shell — real `Input.dispatchMouseEvent` moves at real
coordinates, then `getBoundingClientRect` on the preview, the tile and the row's name, and
`getImageData` on the canvas. What it confirmed: the portal lands on `body`, and at 1920 the
preview sits outside the panel entirely, on the backdrop; the box is inside the viewport at 1920,
1440 and 1100; the tile/name/box columns in the table above; the cold-cache swap from
`304@320px` to `640@320px` with no change of size; 6.8% of the preview painted, so it is a neuron
rather than a blank tile; and that it closes on leave. **Two corrections came out of it**, both in
the direction that matters — a right-hand fallback that the arithmetic liked and the browser
showed covering the hovered row, and a coverage table for 320px that was computed rather than
measured and wrong at 1920, where the preview in fact clears the name. The harness is not
committed, because it drives a reproduction rather than the app — the same reason the ASCII mask
check above is not in the suite. The mock is the one route by which any of this is visible at all:
it has no pyramid, so `detail: 'fine'` there is five radial segments and four times the points, a
stand-in for what `chooseLod` does on a real one.

The sweep was driven the same way, by fingerprinting the drawn canvas across one cycle: 640px
backing store, **16 of 17 distinct frames**, projected width swinging 262 → 563 — which is the
parallax. Screenshots at three points show clearly different views, all framed identically and none
clipped, which is `sweptBounds` doing its job. The same probe is what found both faults the first
version shipped with, neither of which any unit test could have: the painted area was 7.2–7.7k
pixels because the neuron was being swung around the volume's origin, and sampling every 16 ms
showed the framing settling in one frame only *after* the build was reordered centre-first.

**jsdom implements no `PointerEvent`**, so `fireEvent.pointerOver(el, { pointerType: 'mouse' })`
falls back to a `MouseEvent` and drops `pointerType` in silence — a test written that way
exercises the *touch* branch while reading as the mouse one. The suite builds the event by hand
and defines the property on it. It also fires `pointerover`/`pointerout`, never the enter/leave
pair, because React derives those at the root and the non-bubbling ones never arrive. Placement,
sharpness and the fullscreen host are all browser-only.

**No visual verification exists for the thumbnails either** — jsdom has no canvas. What _was_
done once, by hand: rasterising real hemibrain, MANC and male-CNS neurons and printing the mask
as ASCII. An LC4 showed its lobula arbor, thin neurite and terminal tuft; male-CNS body 10001
showed the giant fibre's descending axon. That needed a token and a network, so it is not in the
suite.

**Select-all never truncates, and no longer refuses: past `SELECT_ALL_WARN` (25,000) it says
what it costs and selects.** A selection is provenance — it is in the saved file and in every
downstream cache key — so `stableStringify` walks the whole array on every graph edit: 10k
neuron ids is ~110 kB per key computation, the whole of male-CNS is ~1.9 MB and would make
typing in an unrelated node stutter. That was a *disabled button* at 10,000 until somebody
noticed what it said to a person asking for every VPN in the dataset: that the answer was too
big to have. The cost is real, so the title carries it and the status bar repeats it on the way
past; what is never done is truncation, since "+ all" quietly taking the best 10,000 of 165,122
would be a lie told by a button. It is about the _click_, not the param: ticking rows by hand
still passes it, and a loaded file is never rewritten. See [limits.md](limits.md).

**Which fields become tags is a param, and it is inspector-only.** `chips` is `advanced` (so it
is not on the card — a multi-select above a list of neurons spends the widget's width on its own
configuration) and `presentational` (so restyling a row cannot stale a downstream result).
Empty means "decide for me", which is what the priority list in `rowFields.ts` is for; a
non-empty list is shown **in full and in the given order**, uncapped, because trimming what
someone typed is how a control stops being believed.

That param is also the reason `ColumnParam`/`ColumnsParam` grew **`schemaFrom`**. A column
picker normally reads `attributeSchema` off the type at `from`, and a _Dataset_ socket carries a
source id and a dataset id instead — turning those into a schema needs the data-source registry,
which `src/core` must not import. So the node supplies the lookup
(`schemasFromType(inputs.dataset).neurons`), returning a schema rather than a name list so the
`dtypes` filter, the validation and the picker all keep working unchanged. Resolve it through
`ctx.columns('chips')`, never `ctx.params.chips` — invariant 5 — which is also what drops a
field the current dataset does not have instead of rendering a column of blanks.

It takes the node's **params** as a second argument as well, which `Upload Table` is the reason
for: that node has no inputs at all, so the only place its picker can find a schema is the upload
its own params point at. Every call site already held the params, so the widening cost nothing —
but note what it means, and it is the honest reading of the hatch's original purpose: `from` says
which port must be _connected_, and `schemaFrom` says where the schema actually comes from. On a
node with no ports those are simply different questions.

**A row's chips are tinted by field, and the hue lives in CSS.** `rowFields.ts` assigns each
chip candidate a categorical palette slot keyed to the _field_, so `class` is the same blue on
every dataset and every row; `NeuronRow` emits it as `data-slot` and `--chip-1..8` in
`theme.css` resolve it. Deliberately not computed in JS: a row is memoised, so a hue from
`seriesColor()` would survive a theme switch unchanged, where a custom property re-resolves for
free. `chips.test.ts` guards the resulting duplication. The fill is a 24% tint (label keeps
5.0:1 / 7.1:1, over the 4.5:1 small-text floor) with the hue at full strength on the border.

**The automatic list spends one slot per _fact_, not one per name for it.** A `ChipSpec` can
declare a `family` — `hemilineage`/`itoleeHl`, `consensusNt`/`predictedNt` — and the default
list takes the first member present. Without it a dataset that names one thing twice pushes a
field that says something new off the end of the cap, which is how `consensusNt` disappeared
from male-CNS the moment `itoleeHl` joined `hemilineage` in the list. Only the automatic list
dedupes; a list chosen in the inspector is taken literally, including asking for both.

**The list carries both vocabularies, paired by family.** It was neuPrint's alone —
`class`, `superclass`, `somaSide`, `itoleeHl`, `consensusNt` — and a CAVE row drew **no chips at
all**, because a datastack publishes the same facts in snake_case out of an annotation table and
not one name matched. That was not only the annotation-chain case: FlyWire's *built-in*
annotations are exactly `cell_class`, `cell_sub_class`, `super_class`, `flow` and `cell_type`, so
the shipped dataset had never had a chip either.

Each pair shares a family **and a slot**, which is what makes `class` the same blue whichever
backend the row came from — the stated point of keying the slot to the field. The two spellings
sit adjacent, so `automaticChips` walking the list in order gives the same priority on either
backend. What comes out:

```text
FlyWire + published annotations   cell_class  cell_sub_class  super_class  side  flow
                                  ito_lee_hemilineage  top_nt  nerve
FlyWire, nothing wired            cell_class  cell_sub_class  super_class  flow
male-CNS                          unchanged
```

Two entries are deliberately *not* paired. **`somaSide` and `rootSide` are different facts** —
where the soma sits against where the neurite enters — so they stay two chips; CAVE's `side` is
the soma one and joins that family. And **`flow`** (intrinsic / afferent / efferent) is a fact
neuPrint has no column for at all, so it has no partner and takes slot 4, free on every dataset
that publishes it.

The FlyWire chain fills all eight slots exactly, so `supertype`, `hartenstein_hemilineage`,
`known_nt` and `dimorphism` are left out — `hartenstein_hemilineage` by the same rule that leaves
`trumanHl` unlisted on male-CNS, one of each pair having to lead. The `chips` param is the way to
ask for any of them.

**What is *not* fixed is an annotation base nobody anticipated.** A lab's own SeaTable or an
uploaded CSV has arbitrary column names, and no curated list can meet them; the param is the
sanctioned answer, and its picker sees the chain's columns because `schemasFromType` merges them.
Deriving the list from the schema instead was declined for now — an annotation base is somebody's
spreadsheet with sixty columns, and deciding which of them deserve a chip automatically
(cardinality? dtype? position?) is a judgement worth making deliberately rather than in passing.

**Whether a neuPrint dataset could publish one of the CAVE spellings is not provable here** —
neuPrint's properties are *discovered* per dataset and the custom-query endpoint needs a token. A
family only fires where a dataset carries **both** names, and where it does, one chip instead of
two saying the same thing is the intended behaviour. `chips.test.ts` pins the neuPrint answer as
unchanged, which is the half that would actually regress.

### Community tags: free-form text, drawn as its own thing

Some CAVE datastacks let anyone attach free-form text to a neuron — FlyWire's
`neuron_information_v2` is one row per (neuron, `tag`), with a `pt_supervoxel_id` beside it so a
stale root id can be repaired. Explore Dataset's `Additional tags` param names a column holding those,
and the row draws them **apart from the chips and deliberately unlike them**: their own line
below, smaller type, no palette slot, a hairline border rather than a tint. A tinted chip would
say they came from a known field, which is exactly what they did not — they are somebody's prose
against a neuron, not a controlled vocabulary.

**The shape does not fit the annotation chain, so something has to fold it.** A chain is one row
per neuron — `annotationIndex` and `joinAnnotations` are first-occurrence-wins, deliberately —
and `annotation.caveTable` reads wide (so the *first* tag silently wins) or long via `pivotOn`
(so every distinct tag becomes a *column*, which for free text is thousands). Neither is usable.

So the enabler is a **`join text` aggregation on Group By**, which is a general table op and was
missing outright: there was no way to concatenate strings in a Group By at all. The chain is

```text
CAVE table (neuron_information_v2) → Update root IDs → Group By (by neuronId, join text of tag)
    → Join ← the rest of the annotations → Dataset ▸ Annotations
```

A node rather than a provider mode, on the reasoning `combineColumns` records: gathering values
is not a fact about CAVE tables, and the repair has to run on the *ungathered* rows, where each
tag still has its own supervoxel.

`join` is **distinct**, in first-appearance order, absences skipped. Null and the empty string
are one absence, `coda_combine`'s rule; a group with nothing in it answers **null rather than
`''`**, because an empty string reads as a value to every picker downstream. The unit does not
ride along — nanometres joined with semicolons are not nanometres. `n` still counts **rows**, not
values, so how much agreement is behind a label survives the fold.

**Distinct is the departure from `string_agg` / `paste(collapse=)`, and it was got wrong first.**
The first pass kept repeats on the reasoning that `join` should be what its name is elsewhere and
a Deduplicate upstream is where that decision belongs. That is wrong about what the cell is *for*:
it exists to be read, it is what a community-annotation table folds into, and two people adding
the same tag is the ordinary case there — so a repeat is noise in every use this has, and putting
a node on the main path to remove something nobody wanted is a bad trade. A `Set` in the bucket,
which iterates in insertion order and is what keeps "first appearance" true.

Folded on **exact text**, deliberately: `DA?` and `da?` are different text somebody typed, and
folding them would be an editorial decision an aggregation cannot make. Both generated helpers
match — `dict.fromkeys` in Python rather than a `set`, because it deduplicates *and* keeps order,
and `unique` in R — and all three were run against each other rather than read.

**`JOIN_SEPARATOR` is a contract, not a formatting choice.** `'; '` is written by the aggregation
and split back by the widget, so one constant. Plain text rather than a control character because
the cell is read by people too — it lands in a Table node, a CSV and a notebook — and the cost is
stated rather than engineered away: a tag containing `'; '` comes apart into two chips. Cosmetic,
and the whole cell is one hover away.

**`core.pivot` does not offer it**, and that exclusion is derived rather than listed: a
`MatrixValue` cell is a `Float64Array` slot, so `NUMERIC_AGG_OPTIONS` filters `AGG_OPTIONS`
through `aggDType`. A future text aggregation is excluded by *arriving*; the failure otherwise is
a dropdown entry that silently yields a matrix of zeroes.

**`ColumnParam.dtypes` takes a rule, not only a list**, which is what keeps this one *stored*
param. It was briefly two — `value` numeric and `textValue` not, made exclusive by `visibleIf`,
with an `aggValueParam` indirection saying which was live — because `dtypes` was a fixed array
where `schemaFrom` had been function-valued all along. The split leaked within the hour: both
emitters were corrected to say "needs a value column" while the node's own `validate` still said
"numeric". `dtypesOf` resolves it for the two readers that exist (`availableColumns` and
`validateColumnParams`), both of which already had the params in hand.

**Searching is on by default with an opt-out**, and both halves are `Explore Dataset`'s only params that
are *not* presentational: together they decide which column is kept out of the haystack, and that
changes which rows `Hits` returns. A picker quietly changing a port's contents while claiming to
be a drawing knob is what `presentational` must never mean. `excludedFromSearch` is one function
because two surfaces read it — `evaluate`, and the widget filtering live as you type — and two
spellings would be a list showing rows the port does not carry.

The exclusion reaches the **free-text half only**: a field term naming the column still matches,
since `prepareFieldTerms` reads the table rather than the index, and asking for a column by name
is an explicit act rather than a stray word in a search box. `searchIndexFor` is memoised per
table **and per exclusion** — one entry per table would hand the widget the index a node built
without excluding, which is the disagreement above by another route.

**A row caps at four tags and counts the rest**, with all of them in the counter's `title`. Every
row the same height is what makes a list scannable, and one neuron with forty tags would push
several others off the page. Each tag ellipsises at its own `max-width` with the full text in
`title`, which is CSS — jsdom performs none of it, so what the tests can pin is the half that
makes it recoverable.

**The import nodes' three shaping controls are one factory**, `importShapeParams` in
`nodes/lib/`. `Upload Table` and `Table from URL` are the same node over two ways of getting
bytes — they shared `uploadShapeSchema`/`uploadShapeTable` for the *values* from the start and
hand-wrote the *declarations* twice, which is the asymmetry `colorParams`' own note predicts: the
upload node reported a `Type column` naming a column its file does not carry, and the URL node,
with the same three params written out a second time, did not. The one real difference is where
the schema is found, so that is the argument.

**`chips` is labelled `Fields` on Neuron Profile, and was on Explore Dataset until the header's list replaced it (see above).** The value is a list of *columns*
where `Additional tags` names a column of *values*; two controls called Tags meaning opposite
halves of one row is the confusion the rename avoids. The **id stays `chips`** — that is what a
saved graph carries. Neuron Profile was renamed too though only Explore Dataset was reported: leaving one of the
pair called Tags puts the same confusion one widget over.

**A card shows the same tags as the overlay.** There was a cap on chips in `compact`, on the
grounds that a card is a preview, and it was wrong twice: it hid the seventh chip in the one
place the list is actually read, and it truncated an inspector-chosen list, which is the one
thing that control must not do. `rowFields` already bounds the automatic list; past that,
someone asked by name. `compact` now reaches only the thumbnail size.

**`chipSlots` resolves the row as a whole, not a field at a time,** because the property that
matters on screen is that no two chips in one row share a colour — a repeat says "same kind of
thing" about two that are not. A field takes its declared slot when that slot is free and the
next free one otherwise. The table is arranged so the second branch is rare, which is what keeps
a field's colour stable across datasets; it exists for the two cases that cannot be arranged
away — a dataset publishing both names for one fact (`consensusNt`/`predictedNt`,
`hemilineage`/`itoleeHl`, which share a slot on purpose), and a list assembled in the inspector
out of fields the table never anticipated. Past the eighth chip it hands out nothing: the
neutral chip beats a hue that already means something three chips to the left.

**The colour is a scanning aid, never the identity** — eight hues do not clear the all-pairs
colourblind gate, and chips sit side by side in arbitrary combinations. Validated, not reasoned:
worst pair ΔE 1.6 deutan on the dark surface and 7.1 for normal vision, against a target of 8
and a hard floor of 15. Same finding and same doctrine as the socket colours. So every chip
keeps its text, and `somaSide`/`rootSide` — both `L`/`R` — additionally carry an inline key
(`soma L`), because two identically-lettered chips are a puzzle a tooltip should not have to
solve. `MAX_CHIPS` is 8, the size of the palette, so the automatic list can never want a colour
that does not exist. `trumanHl` is left out of it deliberately — the same fact as `itoleeHl`
under a second nomenclature, and two slots is too much to spend on that by default.

**Custom node bodies** live in `ui/nodes/nodeBodies.ts`, keyed by node type, exactly as
`ValuePreview` dispatches viewers. Registered in the UI and not on the `NodeDefinition`, because
a definition lives in `src/nodes` and must stay headless. A body renders in the card _and_ in the
overlay from the same prop bundle, so it cannot ship working in one and broken in the other, and
it sets the card width through `--node-width` rather than `width` so the run ring still follows.
