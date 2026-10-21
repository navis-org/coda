# Widgets: Dataset Summary

Dataset Summary and the two ROI nodes. [widgets.md](widgets.md) is the index.

## Dataset Summary, and the two ROI nodes

`out.datasetSummary` answers the question that comes before Explore Dataset's and Neuron Profile's: **what is
in this dataset at all?** Neuron counts, how they are classified, and — the part no other surface
here can show — how completely each region has been reconstructed. Codex's Stats page is the
reference; region completeness is the addition, and it is the most useful thing on the card,
because a connectivity result out of a region that is 39% traced means something quite different
from one out of a region that is 91%.

It ships with two ordinary query nodes rather than swallowing their data privately:
`neuron.roiCompleteness` → Table and `neuron.roiConnectivity` → Matrix + Table. Both take nothing
but a Dataset — they are the only query nodes here that ask about the **volume** rather than
about a neuron id list — and both flow into the Heatmap, the Bar Chart, Filter, Download and the
notebook exporter for free. The Summary's own region tiles read the same source methods, so the
card and the nodes cannot disagree.

### Where the numbers come from

`/api/cached/roicompleteness` and `/api/cached/roiconnectivity`, both precomputed on neuPrint's
side, which is why a whole connectome answers in kilobytes and why a card can afford to ask about
male-CNS at all. Measured across every family: completeness is 9 kB / 229 rows on hemibrain and
217 kB / 5,412 rows on male-CNS; connectivity is 211 kB / 63 regions and 681 kB / 111. Both are
cached through `loadCachedTable`, so a graph holding an ROI node and two Summary cards on one
dataset costs one request.

The categorical breakdowns come from the **neuron index** — the same whole-dataset table Explore Dataset
searches — rolled up locally by `nodes/lib/datasetStats.ts`. That is why the Summary loads it on
mount like Explore Dataset does, and why the shared hook below exists.

### Four things that were verified rather than assumed

Each produces a plausible wrong number rather than an error, which is why each has a test.

- **Omitting `?dataset=` returns HTTP 200 for a different connectome.** Not a 400 — neuPrint
  answers about whatever database the deployment defaults to (`optic-lobe` on Janelia), with a
  well-formed 40 kB body. Same class of failure as a query that forgets its base URL, and the
  same answer: `cached()` in `client.ts` takes the dataset as a required argument.

- **The completeness ROI list nests; the connectivity one does not.** hemibrain returns `AL(R)`
  and `AL-DA1(R)` as sibling completeness rows — 229 rows of which 63 tile the volume — so
  summing the column as published gives 20,988,880 presynaptic sites against a true 9,428,400 —
  a **2.2x** overcount, and only the filtered figure agrees with `Meta.totalPreCount`
  (9,496,606). Hence the
  `primary` column, set from `Meta.primaryRois` in the source, and `Primary regions only`
  defaulting to on. But `roiconnectivity`'s `roi_names` is **exactly** hemibrain's 63
  `primary_rois`, so that endpoint has already filtered and a matching param there would be a
  control that never did anything. The two look like a pair and are not; `roiSummary.test.ts`
  asserts the asymmetry so nobody tidies them into agreement.

- **`fetch_roi_completeness` and `fetch_roi_connectivity` are `Client` *methods*.**
  `neuprint.fetch_roi_completeness` does not exist — introspected against neuprint-python 0.6.3,
  the same class of trap as `navis.interfaces.neuprint`. Neither takes a dataset argument, which
  happens to satisfy the "one `Client` per dataset node, and every fetch names it" rule for free.
  `fetch_roi_connectivity` also answers *long* (`from_roi, to_roi, count, weight`), so the
  emitter is a rename rather than a reshape.

- **`roiconnectivity`'s `weight` is not additive, and nobody here knows what it is.** Hemibrain
  `AB(L)→BU(L)` reports `count: 13, weight: 3.11` — weight below count, so it is scaled or
  normalised. Both travel in the Links table because both are what the server said; the matrix
  defaults to `count`, which is unambiguous, and no legend claims anything about weight until
  this is settled against neuPrintExplorer. `MockSource` defines its own `weight` as a synapse
  sum and says so — the two are **not** comparable, which is safe only because nothing reads the
  column's meaning.

**mushroombody publishes neither summary**, returning 200 with zero rows and no pairs. That is a
dataset with no regions rather than a failure, and it is said apart from "not landed yet" — the
same distinction the Description card draws.

### The card

Neuron Profile's two rules unchanged: **a tile renders only when its data exists** (hemibrain has no
`superclass`, MANC no `flow`, and a dataset with no ROI summary draws no Synapses tile rather
than four zeros), and **looking is free** — every param but `Status` is presentational, and the
node returns nothing, so there is no provenance to disturb.

**Region connectivity is not a tile, and it was.** It shipped as an overlay-only heatmap behind an
`enabled` flag that kept male-CNS's 681 kB off the card — and the flag was the wrong answer to the
wrong question. A 63×63 matrix at the size a tile gets is a field of coloured squares with no
readable labels, and shrinking a picture until it is only texture summarises nothing.
`neuron.roiConnectivity` draws the same data at whatever size it is given, into the same Heatmap
the tile embedded, so the capability moved rather than went.

What that left behind is worth noting as a pattern: with one caller and one kind, `useRoiSummary`'s
`kind` argument and `enabled` flag were both dead, so it became `useRoiCompleteness` and says what
it does. The *source* method, its cache and the node are untouched. The test that remains asserts
the **fetch that no longer happens**, with the stub still offering the method — a card quietly
downloading most of a megabyte for something it does not draw is the regression worth catching,
and an absent tile is not evidence of an absent request.

**The caption names the population every time.** The index is `MATCH (n:Neuron)` with **no status
filter** (`cypher.ts`), so the counts are over every neuron the dataset publishes rather than the
Traced subset `Find Neurons` and `IDs from Label` both default to. That is not an inconsistency
to tidy away — those narrow a population somebody asked about, this describes a dataset — but a
dataset-wide count with no stated population is the number that ends up quoted in a paper.

### Which fields get a chart, and what `Charts` means

The automatic list is a priority order (`SUMMARY_ATTRIBUTES` in `nodes/lib/datasetStats.ts`):
taxonomic ranks first because they are how anyone describes a population, then the two "which way
does it point" fields, then transmitter, then the developmental and anatomical ones. Names a
dataset does not publish are skipped, so hemibrain draws fewer charts rather than an empty one.
Two rules narrow it further: numeric columns are excluded outright — a bar chart of "how many
neurons have exactly 1,204 presynaptic sites" is one bar per neuron, which is a histogram's
question — and fields that are one fact under two names spend **one slot between them**
(`FAMILIES`), because a dataset publishing both `consensusNt` and `predictedNt` would otherwise
push something that says more past the cap of `MAX_SUMMARY_ATTRIBUTES`.

**The `Charts` picker had one reading and needed two.** A non-empty list replaced the automatic
set outright, so wanting a ninth chart beside the eight on screen meant naming all nine — and
which eight those are is a fact about *this dataset* that only the priority list can answer. So
`Chosen charts` (`chartsMode`) says what the list is: `added to the automatic ones` or `the whole
list`. Four things about it are load-bearing:

- **Empty means "decide for me" in both modes.** That is what stops the modes being two different
  empty states; `add` differs from `replace` only once a name is in the list, and it differs in one
  direction. Neither mode can *remove* an automatic chart — replacing is the only way to get a
  shorter list, which is why the two are worth telling apart rather than folding into one
  "chosen wins" rule. The dropdown is hidden while the list is empty for exactly that reason.
- **The additions carry none of the automatic list's rules.** No cap and no family deduplication:
  a `somaSide` named by hand beside an automatic `side` is somebody asking for both spellings,
  where the family rule is a tie-break for a list nobody chose. Trimming what somebody asked for
  by name is how a control stops being believed — Explore Dataset's `chips` records the same call.
- **A name the automatic list already picked stays where it put it**, rather than being drawn
  twice or moved to the end. Naming something that was already there changes nothing, which is
  the only honest answer.
- **The default and the absent value differ, and that is `absentMeans`.** A stored graph with no
  key for `chartsMode` was written before the control existed, so its list meant *the whole set*;
  reading it as the new default would redraw somebody else's saved summary the moment they opened
  it. New nodes default to `add`, because that is what the picker is nearly always reached for.
  `populationParams` makes the identical call for the identical reason, and `ValuePreview` spells
  absence the way `absentMeans` does rather than the way `default` does — belt to that document's
  braces.

### Rings, bars and columns

Three chart shapes, and which one a tile gets is a rule rather than a list of field names.

**A ring under five values, bars above it.** A ring is a *part-of-whole* claim and stops being
legible as the slices thin out; a ranked bar chart is a *comparison* and keeps working at fifty.
`flow` has three values and `side` four — those are wholes, and three bars waste the one thing a
reader wants from them. `class` has ten on male-CNS and two hundred on somebody's own table.
Codex splits its own panels the same way; `MAX_DONUT_SLICES` is the rule behind the split.

The ring is drawn with `stroke-dasharray` on one `<circle>` per slice rather than with arc paths,
because a slice covering the whole ring is then an ordinary full-length dash — an `A`-command path
whose start and end coincide degenerates and draws nothing. Labels sit beside the ring, never on
it: slice text has to shrink with the slice, so a 3% category is either illegible or leadered out,
where a legend row is the same width whatever the share. Colour is never the only identification,
the same rule the socket palette and the Explore Dataset chips follow.

**A colour per chart, cycling the categorical palette by position.** Every bar being one blue made
eight charts read as one chart in eight parts. A repeat *across tiles* is harmless — the palette's
all-pairs gate is about series sitting side by side within one chart, which two tiles never do —
so the slices of a ring take adjacent slots and the tiles take theirs by index.

**Region completeness is vertical columns on a fixed 0–100% axis**, which is the whole reason it
is not `Bars` rotated. Completeness is a fraction *of something*, so 90% has to look like nine
tenths of the plot; normalising against the best region would draw it full height whether it were
90% or 9%, and two datasets would be compared on two different scales with nothing saying so.

Two things about that chart were wrong in a browser while every test passed, and both are the
class of bug that produces a plausible picture:

- **A percentage height needs a definite ancestor height.** With `min-height` on the plot the
  columns fell back to their content size and 98% drew very nearly as tall as 57%. jsdom performs
  no layout and reports every element identically, so no test here could have caught it.
- **`flex: 1 1 0` alone spreads six regions across a full-width tile as six slivers.** Capping
  `.tile__column` and left-aligning the plot lets a short chart simply be narrower than its tile.

**The columns chart is three aligned bands — values, tracks, labels — not one flex box per bar.**
The first version stacked all three inside a per-column box, and the labels are vertical text of
very different lengths: `AL(R)` against `mVAC(T3)(R)`. A long name ate its own column's track and
lifted that bar's baseline above its neighbours', so two regions 1% apart drew a centimetre apart.
Three rows of equally-sized cells give every track the same two lines to start and end on, and the
label strip is a *fixed* height rather than a capped one — a name too long for it ellipses, which
is the cost of the alignment and the right way round.

That structure is also what lets a reference line be correct. `bottom: 42%` on the band is the
same 42% the bars are drawn to, where the gridlines this replaced sat in the outer plot — with the
value and label rows shortening the bars' own box, so the 50% rule landed nowhere near the middle
of a 50% bar. That is why those were removed rather than fixed in place; this one shares the box
by construction.

**The mean line takes `--text-primary`, not `--text-muted`.** It shipped muted, on the reasoning
that a reference should not compete with the bars — and `--text-muted` is `#898781` in *both*
themes, which clears the 3:1 non-text floor for body text and disappears as a 1px dash crossing a
field of saturated green. It did not compete; it vanished. The ink token is `#0b0b0b` on light and
`#ffffff` on dark, which is as far from the chart as this palette goes, and still achromatic —
that part was never the problem, since a coloured rule over a categorical chart reads as another
series. The dash is what keeps it a reference at full contrast, and the label carries
`--surface-2` behind it because it sits *on* the bars, where white-on-light-green is the one
pairing the palette cannot survive.

Pinned by reading the stylesheet, as the Neuron Profile 3D tile's rule is: vitest applies no CSS and
jsdom resolves no custom properties, so a declaration test is the only kind that catches a
chart-chrome colour going invisible. Nothing else did — it looked deliberate.

**The mean is weighted, and that is the whole of the number.** Total traced over total present,
not the average of the per-region fractions. Averaging gives a ten-synapse neuropil the same vote
as `ME(R)`, which holds a fifth of male-CNS's volume: measured there, the weighted postsynaptic
mean is **41.8%** against **38.2%** arithmetic. The weighted figure is the one that answers "what
fraction of this connectome's postsynaptic sites belong to a reconstructed neuron", and the one
that agrees with the Synapses tile above it. It is computed over every drawn region and never over
the page, or the line would compare each page against itself.

**How many columns fit is measured, not chosen.** The completeness tile is full width in the
overlay and a fraction of a 560px card, so a fixed page size suited neither — ten columns used
half the overlay and still paged seven times through hemibrain's 63. `useElementSize` on the plot
and a `MIN_COLUMN_PX` floor gives 53 columns in the overlay and 20 on the card, each dividing the
width it is given. The floor is set by the *value* label rather than the bar: `100%` in the 8.5px
mono face is about 24px, and a column narrower than its own number clips it. The bar would read
fine at half that.

Two things about that measurement, both of which broke it first:

- **The measured box wraps `Loadable`, never the other way round.** `useElementSize` observed
  once, on mount, and bailed when the ref was empty — so a box rendered inside the loading branch
  was null exactly when the observer was set up, and was never seen again. The chart then kept the
  fallback page size for the session, which read as a chart that simply chose a small number
  rather than as a measurement that never happened. The hook now observes whichever element is
  under the ref after every commit (it was found again in Laminar Profile, and every chart viewer
  returning its empty state before the measured box had the same trap), so this ordering is no
  longer load-bearing; it is kept because it is still the simpler tree.
- **The wrapper is measured, not the plot.** Measuring the element whose child count the
  measurement decides is a feedback loop.

**`Region order` is ranked or by name**, and the pair is the point: ranked answers "where can I
trust this?", which is a question about the shape of the list, while by-name answers "how complete
is the region I already care about?" — and on male-CNS's 144 paged regions that is the difference
between looking something up and hunting for it. The name sort is `localeCompare` with `numeric`,
so `ME_R_col_10` follows `ME_R_col_9`; male-CNS names thousands of regions that way and a plain
string sort produces an order that reads as a bug. The value sort breaks ties on the name for the
same reason every ranked list here does — otherwise equal regions swap places between renders.

**There are no gridlines**, and they were drawn and removed rather than never tried: the rules sat
in the plot while the bars scale inside their own tracks, which the value and label rows shorten,
so the 50% line landed nowhere near the middle of a 50% bar. Every column prints its percentage,
so the reference was redundant as well as wrong.

**The primary ROI list comes from the *listing*, not from discovery.** `superLevelROIs` in
`/api/dbmeta/datasets` is `Meta.primaryRois` — checked set-for-set on every dataset the server
offers, identical every time — so it is read when the listing lands rather than two round trips
later, and it is there even if the `Meta` query fails. Discovery still overwrites it, since `Meta`
is the documented source and this is the same answer arriving sooner.

Two things that were wrong until it did. **Re-listing un-learned it**: `listDatasets` re-fetches on
every call and the Sources panel does exactly that, and the merge overwrote `primaryRois` back to
undefined — the trap the `statuses` line beside it has been guarding against since it existed, now
guarded for both. And **the card reported the wrong regions**: the Dataset tile printed
`info.rois.length`, so male-CNS read `regions 5,619` an inch above a chart over 144 and a caption
saying "144 primary regions" — two numbers on one card both called regions, thirty-nine times
apart, with nothing saying which was which. It now reads `144 primary of 5,619`, and says one
number where every region tiles the volume, as MANC's 59 do.

**The completeness chart drops only what it knows to be nested**, and getting that wrong emptied
it completely. `primary === false` is a region inside another one; `null` is the source saying it
could not tell yet, and an absent column is nobody having asked. A single `!== true` test read all
three as "nested" — and because it applies per row, every row failed at once, so the chart did not
degrade, it vanished behind the word `None`. Same unknown-is-not-empty rule as `columnSchemaFor`
and `validateColumnParams`; the difference here is that the failure is total rather than partial,
which is what makes it read as a fact about the dataset.

For the same reason the tile never says a bare `None`. Three different things read as "no chart"
and only one is about the connectome — no regions published, nothing recorded for *this* measure
while the other one works, or no synapses anywhere — so it names which, and points at the other
measure when that is the answer.

**A null completeness is checked before the conversion, never after.** `Number(null)` is `0` and
`Number.isFinite(0)` is true, so testing the converted value drew a region with nothing recorded
as a confident 0% column. The same trap `numeric()` exists for, found by the test written for the
paragraph above rather than by reading the code.

**Paging replaced the `Other` residual**, and that is a change of claim rather than of layout. A
residual says "there are 206 more and you cannot see them"; a pager says "there are 206 more, here
they are". Nothing is hidden, so nothing has to be admitted — the heading carries `9–16 of 214`.
Bars are scaled against the *whole* ranked list rather than the page, or page two would redraw its
largest bar full width and read as matching page one's.

**The page index is component state, not a param.** Neuron Profile's pager writes one because it feeds a
`Current` port and has to survive a reload; nothing here feeds anything, so which slice of a chart
is on screen is not a fact about the document — and a param would have to be one *per column
name*, which is a schema the node cannot know at definition time.

**`Completeness` is presynaptic or postsynaptic, and there is no third option.** neuPrint
publishes `roipre`/`roipost` per region and nothing else; `Meta.roiInfo` adds only
`mito`/`dark`/`light`/`medium`, which are EM annotations rather than tracing, so a
connection-level completeness would need per-connection data nobody publishes. Postsynaptic is the
default because it is the figure that bounds what a connectivity query can see — a connection is
only found when the *receiving* neuron is reconstructed — and the two differ by fifty points on
hemibrain, 91% pre against 37% post. The control is on the tile rather than only in the inspector,
because a switch that moves the reading that far belongs where the reading is.

**`statsFor` is a `WeakMap` memo in `searchIndexFor`'s idiom**, and it is what makes a Summary
card nearly free once Explore Dataset has paid: eight columns counted over 165,122 rows, once per table
identity, with the cap applied on the way out so a "show more" control costs no recount. Note the
knock-on in the viewer — the status filter is `useMemo`'d, because a fresh filtered table per
render would defeat the memo entirely and re-count everything on each unrelated store tick.

**`nodes/lib/datasetStats.ts` is headless**, the sibling of `profileStats.ts` and for the same
reason: jsdom has no canvas, so anything left in the component is covered by nothing. Two rules in
it are worth knowing. Null and empty string are the **same** absence and are folded before
ranking, because neuPrint publishes both for one thing depending on the property. And absence is
counted *apart* from the ranked values by default — "unspecified" is not a class of neuron, and
letting it in puts it near the top of most male-CNS attributes where it crowds out something that
says anything. Codex charts it as a bucket; here `includeMissing` is opt-in.

### The shared index hook

`ui/useNeuronIndex.ts`, moved out of `ui/explore/` when the Summary became its second consumer.
The *download* was already shared — `loadCachedTable` keys on (source, dataset), shares an
in-flight promise and persists to IndexedDB, and `cacheGet` promotes a hit into a module-level map
that hands back **the same object**, which is also why `searchIndexFor`'s `WeakMap` hits across
widgets. What was not shared was everything above it, and each of the three was invisible until a
second consumer existed: each mount set `status: 'loading'` before awaiting a call that resolves
from memory, so a second card flashed a spinner over data it already had; each printed its own
"downloading index" note for one download; and a reload pressed on one left the other showing the
table it had just replaced.

**Nothing is aborted on unmount, and that is deliberate.** The obvious `AbortController` is
actively wrong once the state is shared — the first card's unmount would cancel the fetch the
second is still waiting for, which is the trap Neuron Profile's paging already documents. There is also
nothing to save: the result is cached, so a download completing after the last widget has gone is
paid for and kept, where one abandoned half-way starts from zero.

**The load starts from an effect, never from render.** `ensureLoaded` publishes synchronously on
several paths, and publishing is *other components'* `setState` — during render that is React's
"cannot update a component while rendering a different component", between sibling node cards with
no relationship to each other. Nothing is lost by waiting a tick: a second widget feels instant
because the entry is already `ready` when its first `getSnapshot` runs, not because of the timing.

`resetNeuronIndexState()` is the test seam; module-level state outlives a test file otherwise.

### Tiles are shared, not copied

`ui/viewers/Tiles.tsx` — `Tile`, `Loadable`, `Facts`, `Bars` — extracted from `ProfileViewer`
rather than duplicated, the same call `LegendKeys` records. The stylesheet block was renamed with
them, `.profile__tile` → `.tile`, because a prefix naming one of two consumers is a claim that
goes stale; same call, and the same reasoning, as `.labels-body` becoming `.list-body` when
`InputIdsBody` joined it. What stayed in `ProfileViewer` is what knows its subject — the chips,
the shape preview and the pager.

**Its `ValuePreview` branch sits above the `!value` guard, and that placement is the whole reason
the card renders.** Every other viewer has an output port, so after a run it has a value and the
guard is a "nothing yet" state it passes through once. This one has **no outputs**, so its value
is undefined forever — below the guard its branch is unreachable and the card shows
`No result yet — run the graph to see output.` permanently. That is what it did, with a green
suite: every jsdom test rendered `DatasetSummaryViewer` directly and so could not reach the
dispatch at all. Found by pointing a real browser at it; `datasetSummary.test.tsx` now drives
`ValuePreview` itself, and that case fails if the branch is moved back.

**No visual verification exists for the card**, on the standing of the WebGL viewers: jsdom does
no layout, so the tile grid's reflow and the bar geometry are not asserted. They were looked at
once by hand, against the mock connectome in a real browser — which is what turned up the guard
above, the `wide`/`span` collision on the connectivity tile (an element carrying both takes
whichever rule the stylesheet declares later, and it is the span), and `Top cell types` at
Codex's twenty pushing the region tiles off a 620px card.
