# The four browsing widgets

Explore Dataset, Neuron Profile, Dataset Summary and ROI Viewer — the surfaces that fetch for themselves.

Moved verbatim out of `CLAUDE.md`.


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

**Ranking is a bucket partition, not a sort.** Five tiers (exact / prefix / substring in
`type`|`instance`|`neuronId` / substring anywhere / subsequence), so it is O(n) and can rank
_every_ hit. An earlier version gave up above a threshold, which left the real DNp01 neurons
thousands of rows deep in a 21k-row fuzzy set — i.e. "fuzzy search does not work".

Non-obvious rules pinned by tests: a missing value satisfies `!=` and nothing else (so
`status!=Traced` finds the untraced _and_ the unlabelled, where SQL's three-valued logic drops
both, silently); regexes are **unanchored**, deliberately unlike neuPrint's `=~`, because this
search is local and has no server semantic to match; and only `neuronId` and string columns join
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
retires the bad entries, and `explore.test.tsx` seeds a real one to prove it.

**Thumbnails are the coarsest published mesh, projected.** No token — meshes come from public
buckets, so they work in a static deploy where the Cypher API cannot reach. `thumbnail.ts` is
pure and returns a one-byte-per-pixel **coverage mask**, not RGBA: 9 kB rather than 36 kB, and
carrying no colour it survives a theme switch, which a cached tile with the theme baked in would
not. Triangles are filled and depth-shaded (brightest-wins, so overlapping branches do not
saturate); vertices alone would be a dotty cloud at that level of detail.

**Which sources have them is a question about pyramids, not about backends.** `fetchCoarseGeometry`
is optional on `DataSource` and `undefined` means "draw a placeholder", which for a source with a
single level is the honest answer rather than a gap: the alternative is a page of 25 rows fetching
several megabytes each. neuPrint's published buckets qualify; so does a CAVE dataset whose
materialization has a flat segmentation beside it (`DatastackSpec.flat` — see
[backends.md](backends.md)), which is what took FlyWire's rows from a placeholder apiece to a
drawing. A CAVE dataset with only the `graphene://` segmentation still shows placeholders, and
will: a graphene manifest is several hundred supervoxel fragments at full resolution with no level
to trade against. `fetchCoarseMesh` in `precomputed/index.ts` is the one implementation both
sources call, so the byte ceiling and the "coarsest level" trick cannot be spelled two ways.

**Rasterised at 2× the box it is drawn in** (`RASTER_SCALE`), because the mesh has more detail
than a 76px tile can hold — at 1:1 a thin neurite either landed on a pixel or vanished, and a
HiDPI screen was upscaling the result. The browser downsamples, which is what turns the surplus
samples into antialiasing, so `image-rendering` must stay `auto`. The cost is 4× per cached mask
(23 kB, not 5.8 kB), which is the reason not to go to 3×. The raster size is part of the cache
key, so masks stored at the old resolution are a miss rather than a tile at the wrong scale.

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

**`chips` is labelled `Fields` now, on Explore Dataset and on Neuron Profile.** The value is a list of *columns*
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

## Neuron Profile: one neuron at a time

`out.profile`, the counterpart to Explore Dataset one level in — Explore Dataset answers "what is in this
dataset?", Neuron Profile answers "what is this cell?". Modelled on Codex's Cell Details page. It takes
a whole neuron collection and pages through it, so it works on an Explore Dataset selection or a
Connectivity result, not only a hand-picked body.

**Browse free, pin to commit — the whole design turns on this.** `page` is presentational, so
flipping through twenty-seven neurons costs nothing and invalidates nothing; `selection` is not,
and it is what the `Current` port emits. Had the page index fed `Current` directly, every press
of the pager would mark the downstream graph stale, and with auto-run on would fire a full pass
per page turn. Same live-widget/committed-param split that makes Explore Dataset feel like a browser.
`profile.test.ts` asserts it through the scheduler, because dropping the flag fails no type
check and the symptom — a graph going stale whenever anyone browses — reads as a scheduler bug.

**`minWeight` and `topN` are presentational too, and that is not an oversight.** Neither can
change a byte of what either port carries: the outputs are the pass-through and the pinned row.
They decide what the widget draws. The threshold is also not passed to the fetch, so raising it
never costs a round trip — one request at weight 1 serves every threshold above it.

**`cheap`, despite the widget fetching.** `evaluate` touches no network at all. The connectivity
and ROI requests are the widget's, issued per neuron _viewed_. Same reasoning as
`out.neuroglancer`.

**Three requests per neuron, and identity is free.** Type, classification, transmitter call and
synapse totals all come off the neuron's own row in the incoming table, which already carries
every column schema discovery found — no index download, no query. Only the two connectivity
fetches and the ROI breakdown go to the wire, and they are cached per body.

**`roiInfo` nests, so the region bars must filter.** A synapse in `LO(R)` is counted again in
its parent `OL(R)`; summing the raw blob reports roughly twice the neuron's synapses. Only
`Meta.primaryRois` names a set that tiles the volume, so `DatasetInfo` grew `primaryRois` and
`runDiscovery` now captures it — the Cypher already returned it and threw it away. Note the
`ordered` swap at the end of discovery is now unconditional: it carries the ROI list as well as
the statuses, and a dataset whose status sample came back empty would otherwise keep handing out
an info without it. When the list has not arrived the widget says the totals may double-count
rather than presenting them; `undefined` is not `[]`.

**Paging is debounced, not aborted, and the distinction is load-bearing.** Two profiles on the
same neuron share one in-flight request, so cancelling on unmount kills the fetch the other one
is still waiting for. Not fetching for `SETTLE_MS` has no such failure mode, and a neuron already
cached skips the wait entirely — so paging back through what you have seen stays instant.

**The card and the overlay show different 3D on purpose.** The card draws the cached coarse
silhouette (free, usually already fetched by Explore Dataset); the overlay mounts a live neuroglancer
frame, in a tile that is **2×2**. A grid column is ~190px, which is not a 3D viewer — it is
about the width of neuroglancer's own layer bar, so a one-cell tile showed the chrome and
nothing else. The `min-height` on that rule is the half that actually does the work: rows are
auto-sized, so spanning two of them beside tiles that are five lines of text tall resolves to
roughly one card's height, and the span alone would make the tile wider and no taller — which
looks like it worked. `profileViewer.test.tsx` asserts the declaration, since jsdom does no
layout. (`uiScale` is the other lever for the same complaint; the frame does not use it yet.) Each frame is a full WebGL application that starts fetching EM on mount and a canvas can
hold a dozen profile cards. The card carries an `Open 3D` control inside the tile, because a
difference the user cannot see is a bug. `NeuroglancerProfileFrame` wraps `NeuroglancerViewer`
rather than reimplementing it — the `#!+` merge is what keeps the camera across a page turn, and
it was established against the deployed viewer rather than reasoned about.

**A tile renders only when its data exists.** Datasets disagree about nearly everything, so a
tile that cannot say anything is absent rather than full of dashes, and nothing in the widget
names a column that must be present. `transmitterReading` matches by name against whatever
discovery found — and checks presence _before_ `Number()`, because `Number(null)` is 0 and a
missing probability would otherwise draw a confident zero-length bar. Same trap `numeric()`
exists for.

Two small general changes came out of this, both worth knowing about:

- **`ValuePreview` gained `onParamChange`.** The viewer-to-node write path was hardcoded to
  `selection`; the pager needs `page` as well. `onSelectionChange` stays as the narrow
  convenience for the three viewers that only ever write a selection.
- **`ColumnsParam` gained `optional`.** A decorative picker with nothing to offer is not an
  issue — Neuron Profile's `Tags` on a table whose schema is not yet known was raising a warning badge
  about a control nobody had touched, which is how a real issue further down the list stops
  being read.

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

- **The measured box wraps `Loadable`, never the other way round.** `useElementSize` observes
  once, on mount, and bails when the ref is empty — so a box rendered inside the loading branch is
  null exactly when the observer is set up, and is never seen again. The chart then keeps the
  fallback page size for the session, which reads as a chart that simply chose a small number
  rather than as a measurement that never happened.
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

## ROI Viewer: the volume rather than the cells

`out.rois`, `Add ▸ Visualisation ▸ ROI Viewer`. Explore Dataset answers "which neuron?", Neuron Profile "what is this
cell?", Dataset Summary "what is in here?" — all three about *cells*. This one is about the space
they sit in: a dataset's neuropil shells drawn together in a named anatomical plane, coloured by
how completely each is traced. It is the only surface here that can answer "where is `LO(R)`, and
how much of it can I trust", which is otherwise two lookups and a mental model of fly anatomy.

**A Dataset Summary, not a 3D View.** The obvious sibling is `out.viewer3d`, since both draw
meshes, and it is the wrong one: that node takes geometry *on a wire* and something upstream
fetched it. This takes a Dataset and fetches for itself, which is `out.datasetSummary`'s
arrangement exactly — no outputs at all, an entry in `SELF_DRAWING_NODE_TYPES`, and `cheap`
despite the widget downloading tens of megabytes, because `evaluate` confirms the input is a
dataset and returns nothing. What a viewer fetches for itself is not what the scheduler has to
reason about.

### Three planes and no camera, which is the decision everything rests on

x/y, x/z, y/z. There is no free rotation, and that is not a limitation worked around — it is what
makes the whole thing affordable.

With an arbitrary camera the geometry has to be **kept**, because any angle can be asked for at
any moment. With exactly three projections there are exactly three answers, so a region is
fetched once, flattened into all three, measured, and **discarded**. What survives is polyline:
measured at **42 kB for hemibrain's 63 regions and 95 kB for male-CNS's 139**, against 29–62 MB
of mesh. Roughly three orders of magnitude.

Three further consequences, each of which deleted code rather than adding it:

- **Rendering is free.** Drawing is one transform over cached points, so there is no re-projection
  per frame at any region count. An earlier 3D build needed a reduced trace grid while dragging
  and a rule about reusing the previous frame's explode solution; both went away.
- **The trace grid can be larger than an interactive budget allows.** It is paid once, so
  `TRACE_GRID` is 512 rather than 256 — measured over all three planes including the relaxation:
  63 regions 108ms, 144 regions 291ms. 768 buys a quarter more points for 60% more time and stops
  being visible.
- **Every view is reproducible.** "Frontal" is a claim anyone can check against the picture, where
  a camera that happens to be pointing that way is a pair of angles nobody can read off one.

### Outlines are traced from a raster, never swept from a centroid

The obvious outline is the maximum projected radius per angular bin, and it can only describe a
*star-shaped* region. Neuropils are not: the mushroom body lobes wrap the peduncle and the gnathal
ganglia are plainly concave, so a swept outline silently fills in its own notches and draws every
region larger than it is. `roiProjection.ts` rasterises the projected triangles and walks the
boundary instead; `raster.test.ts` asserts that a point in a C's hollow is *outside* the ring.

**`raster.ts` was extracted from `thumbnail.ts` rather than copied.** The barycentric fill is the
same arithmetic whether it is shading a neuron thumbnail or filling a neuropil, and two copies
would drift on exactly one thing — whether a pixel centred on an edge is inside — with the symptom
a one-pixel seam in one viewer and not the other.

**The tracer's stopping criterion is load-bearing and its failure is invisible.** Moore-neighbour
tracing with no Jacob criterion walks the boundary repeatedly: the first version returned 177
points for a 44-pixel perimeter. That *looks* like a correct outline — but an even number of
traversals doubles every ray crossing, so the ring reads as **inside-out** to point-in-polygon.
The concavity test reported the hollow solid and the solid parts hollow.

### The explode is collision relaxation, not a radial push

Sliding each region away from the centroid is the obvious rule and it does not work: scaling every
centre about one point is a **homothety** — a uniform scale of the arrangement. The shapes do not
scale with it, so once the frame refits, the only perceptible change is the regions getting
smaller. It reads as pulling the camera back.

So `relaxShifts` does what nat.ggplot's exploding-neuropils does: each region is a disc *in the
projected plane*, and overlapping pairs nudge apart until none overlap. Non-uniform by
construction, so the picture un-stacks rather than scaling. Solving it in the view plane is the
other half — separation is guaranteed in the projection being looked at, which a 3D push never
promises, since two regions far apart in depth can sit exactly on top of each other on screen.

**The constants were measured against how much of each region is left visible** — rasterise in
depth order, nearest wins, count what survives. Frontal goes 61% → 93% mean visible and its worst
tenth 7% → 82%; lateral, nearly unreadable at rest, 23% → 88%. Disc radius is the **70th
percentile** vertex distance, because a disc around the furthest vertex of an elongated neuropil
claims far more room than the shape occupies. The anchor pull is **0.05**: at 0.22 it gives back a
third of the visibility to save a tenth of the frame growth.

**The push is biased sideways, and 100% is 1.5x just-separated.** A screen is wider than it is
tall and so is a brain, so vertical room is the scarce kind: unbiased, the frontal arrangement
explodes into a *portrait* block and wastes two fifths of a landscape card. `LATERAL_BIAS` rotates
each push toward the horizontal - a bias, not a constraint, so a pair stacked exactly vertically
still separates vertically. 1.7 is measured on share of a 620x460 card covered: frontal 62% -> 97%,
lateral 62% -> 98%, dorsal 99% either way. Past it the arrangement over-corrects into a letterbox
and the fill falls again, so it is an optimum rather than "more is better". `EXPLODE_GAIN` then
scales the finished displacements, because the solver stops at *just* separated and that reads on
screen as regions that have only barely stopped touching.

**The frame is held at full explode for every slider value.** Refitting per frame is the other
half of why a radial explode read as shrinking — the arrangement grows, the frame chases it down,
and size is the only thing left changing. The cost is that at rest the regions are drawn at 71–81%
of the available scale on a half brain and 64–87% on a whole one.

**Homologous regions move as mirror images.** Left unconstrained the solve treats `ME(L)` and
`ME(R)` as two unrelated discs, so a bilaterally symmetric brain explodes lopsided — which reads
as a mistake, because the anatomy plainly is not. Each pass projects the shifts onto the
symmetric subspace: a pair's screen-x displacements are averaged to opposites, its screen-y to a
common value, and a midline structure is held on the midline. Enforced *inside* the loop, because
symmetrising a finished layout moves regions after the last collision check and can push them
back into each other.

Measured on a synthetic bilateral brain, worst pair mirror error against a shift scale of ~7,700:
frontal 11,283 → 0 with visibility 95% → 94%, dorsal 2,545 → 0 with visibility 79% → **81%**. The
free solve was putting pairs further out of step than the displacements themselves; the
constraint costs at most a point and dorsal gains two, because shrinking the search space lands
on a better arrangement rather than a worse one.

**It stands down where it would mean nothing, and both cases matter.** A half brain — hemibrain
is one hemisphere plus the midline — has no twin for most regions, so pinning a midline
structure's sideways travel would buy symmetry the dataset does not have while costing the solver
a degree of freedom it could spend separating something. And **lateral is excluded entirely**:
that plane projects *down* x, so the mirror axis is the depth axis, homologous regions land on
exactly the same point, and "mirrored" degenerates to "identical" — which would pin every twin
superimposed forever, the one thing the explode is there to fix in that view. That superposition
is also why lateral leans on the coincident-centre tie-break, and most of why the `hemisphere`
filter exists.

### Getting the meshes, and why the card asks first

Everything below was established by `scripts/probe-roimeshes.mjs` against the live server. Each
would have produced a plausible wrong result.

- **`/api/roimeshes/…` 404s on `HEAD` and 200s on `GET`.** The probe's first version asked with
  HEAD and reported every dataset as having no meshes, directly above the megabytes of OBJ its own
  GETs had printed.
- **Coordinates are dataset voxels**, like skeletons and unlike the precomputed meshes. Unscaled,
  the shells sit a whole factor from every neuron drawn beside them, with nothing failing because
  both sets are internally consistent.
- **The OBJ dialect differs by dataset.** hemibrain writes bare `f 1 2 3` with no normals;
  male-CNS, MANC and optic-lobe write `f 1//1 2//2 3//3`. A parser assuming the first reads normal
  indices as vertex indices on three datasets out of four — and the counts match, so it builds the
  right number of triangles between the wrong points.
- **Four of thirteen datasets publish none at all** (banc, fib19, mushroombody, wasp3), which is
  what `capabilities.roiMeshes` declares. Within male-CNS exactly five regions refuse, and every
  one is an `-unspecified` bucket — unassigned synapses, not a shape. So a refusal is counted, not
  raised, and the caption says `139 of 144`.

**It is 29 MB gzipped for hemibrain and 62 MB for male-CNS** — four to nine times Explore Dataset's
whole-dataset neuron index. So the card opens on an explicit `Load N regions` rather than fetching
on mount. What lands is the polyline above, cached, so the second open has no button and no wait:
`idle` means "not stored", never "never loaded".

**The precomputed buckets were investigated and do not generalise.** hemibrain publishes
`neuroglancer_multilod_draco` ROI meshes at 0.4 MB for every region at finest detail — 73× better.
male-CNS and MANC publish `neuroglancer_legacy_mesh`, single-resolution, ~128 MB. There is no
uniform win, so the OBJ endpoint is the route and hemibrain's bucket is a fast path if it is ever
worth the special case. Worth knowing that `/api/npexplorer/nglayers/…` answers **unauthenticated**
and names the ROI layer outright for MANC, male-CNS and optic-lobe.

**A byte budget is the wrong lever, which is counter-intuitive.** Fetching cheapest-first would
drop `ME(R)`, `LO(R)` and `LOP(R)`: the largest files are the largest *structures*, so a budget
silently deletes the map's dominant features.

**Meshes are decimated as they arrive, not after the batch** (`data/meshDecimate.ts`). Vertex
clustering rather than quadric error — deterministic, one linear pass, and what it preserves best
is the silhouette, which is all the tracer reads. `DEFAULT_DECIMATE_GRID` is 32 because surface
cells go as `π · grid²`, so 32 lands near 3,200 vertices; 64 was the first guess and is *finer*
than several regions' own vertex spacing, merging almost nothing.

### Colour, and the one place the palette rule does not apply

Completeness (pre or post) on a sequential ramp, `region`, `side`, or flat. The two sequential
modes get a labelled ramp over the map - reusing `.colorbar` from the network legend rather than
growing a second one - and the others get none, because three colours and one need no key.

**Presynaptic reads red and postsynaptic blue**, which is the one place this app runs two
sequential hues. They are otherwise the same picture over different numbers, so with a single hue
a glance cannot say which measure is on screen - and on hemibrain the two differ by more than
fifty points, which is exactly the gap somebody could take off the wrong one. It is not an
all-pairs case: a viewer shows one or the other, never both. `sequentialColor` gained a hue
argument rather than a sibling function, because a second copy of the mode flip is how a
dark-mode ramp comes to read as a negative.

`RED_RAMP` was already in the validated palette as the diverging scale's positive arm; what is new
is using the whole of it, so its sequential claim was checked rather than assumed - monotonic in
lightness, luminance 0.729 to 0.055 against blue's 0.743 to 0.038, minimum step 0.032 against
blue's 0.018, end contrasts matching blue's within a tenth of a stop.

**`region` gives each neuropil its own hue and is deliberately not a categorical encoding.**
`colors.ts` never cycles a ninth hue, because in a chart a repeated colour claims two series are
the same thing. Nothing is encoded here: there are 63 to 152 regions, no legend could list them,
and the hue means only "this shape is not that shape" - the job neuroglancer's segment colours do,
hashed for the same reason. It is keyed on the **homology key**, so `ME(L)` and `ME(R)` come out
identical: they are one structure seen twice, and different hues would say the opposite. Hue is
the hash times the golden angle rather than `hash % 360`, which leaves consecutively named regions
looking alike often enough to notice.

### The level above the primary regions

Some datasets publish an ROI hierarchy, and the group above a primary region is what lets a map
of 144 of them be read a system at a time. When one is available the control bar grows a
**Groups** dropdown of checkable items beside the colour selector; when it is not, there is no
dropdown at all.

**`Meta.roiHierarchy` is the source**, a nested `{name, children}` tree, and it arrives as a JSON
*string* — neuprint-python decodes it server-side with `apoc.convert.fromJsonMap`, which this does
not depend on, so it is parsed in `roiHierarchy.ts`. Worth recording that
`Client.fetch_roi_hierarchy` **does not exist**: it is `neuprint.fetch_roi_hierarchy`, a
module-level function. The same shape as the `navis.interfaces.neuprint` trap — the obvious
spelling is a well-bound name and an AttributeError.

**A super ROI is the nearest ancestor that is neither primary nor the root**, and both exclusions
earn their place. The root is the dataset itself, so admitting it yields one group containing
everything: a control that does nothing dressed as one that does. And a primary region's own
children are *sub*-primary — they nest inside it — so the walk stops rather than mapping them to a
group they are only indirectly in.

**A region with no group is never hidden by a group filter.** hemibrain lists `AL(L)` and `GNG`
directly under the root, so ungrouped is the common case rather than an oddity — and no box could
ever be ticked to bring such a region back.

**Empty means every group**, the `chips` idiom, which makes the first untick the interesting one:
it expands to the full list minus one rather than starting from nothing, or unticking a single
group would hide every other and read as the control being inverted. Unticking back down to the
full set returns to empty, so "everything" has one stored form rather than two.

The mock declares a hierarchy of its own (`MOCK_ROI_GROUPS`) rather than going without, so the
control is demonstrable with no token — and the groups are the anatomy those regions really belong
to, because a control demonstrated on nonsense teaches the wrong thing about what it is for.

### Volume is carried and is marked an estimate

neuprint-python's own docstring says these meshes are "intended for visualization only. (They are
not suitable for quantitative analysis.)" — and Coda decimates them further before measuring. The
number is still carried, because nothing else in the app can say anything at all about a region's
size, and the tile is captioned `≈ from display mesh`. An unlabelled `7.9 × 10⁶ µm³` on a card
reads as a measurement.

### Smaller things that would each be a quiet lie

- **The `ValuePreview` branch is above the `!value` guard.** No outputs means the value is
  `undefined` forever, so a branch below it is unreachable and the card reads "No result yet"
  permanently. `out.datasetSummary` shipped exactly that with a green suite, because every test
  rendered the viewer directly — so `rois.test.tsx` drives `ValuePreview` itself.
- **Every param is `advanced`**, `out.neuroglancer`'s call: the map draws its own control bar, so
  generic rows above it would be the same four controls twice, spending a fifth of a 460px card.
  They stay `presentational`, so the expanded view's rail still offers them.
- **An absent `primary` column reads as unknown, not as nested.** A source that says nothing has
  not said its regions sit inside others — the same unknown-is-not-empty rule as `columnSchemaFor`.
- **The outline cache's fingerprint carries the format version, the trace grid and the region list
  by name.** Once the meshes are released these polylines are the only copy, so nothing about a
  stored set reveals which tracer produced it. That is the thumbnail cache's lesson, which
  persisted *refusals* and silently outlived the byte ceiling that created them.
- **Regions are focusable and named** (`role="button"`, `aria-label`). Colour is never the only
  channel here, and it is also what lets `.roi__label` stay `pointer-events: none` so a name never
  blocks the shape under it.

**No visual verification exists**, on the standing of the WebGL viewers: jsdom does no layout, so
the grid areas, the outline geometry at real sizes and the label thinning have not been looked at
by anyone. Everything testable is tested headlessly, and the mock source generates synthetic
shells so the node works offline and on every bundled example.
