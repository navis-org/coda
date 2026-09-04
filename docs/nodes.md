# Node semantics

One section per node whose behaviour cost a decision. See also `adding-a-node.md`.

Moved verbatim out of `CLAUDE.md`.


## Text notes

`note.text`, added from `Add ▶ Utility ▶ Text`: a framed block of markdown on the canvas. It is
what a graph cannot say about itself — why this type pattern, why this threshold, what the chart
at the end is meant to show.

**It is a `GraphNode` with `annotation: true`, and both halves of that are deliberate.** A
separate `annotations` array on `CodaGraph` would have to re-implement position, selection,
undo, autosave, serialisation, the library, duplication and the minimap — every one of which a
node already has — for a feature whose entire content is a string. So it is stored as a node.
What makes it _not_ a node is the flag: no ports, never evaluated, no provenance key anyone
reads, and its own card.

`annotation` is read in exactly five places, and each one would be a visible lie without it:

- `Scheduler.refreshStates` gives it **no state at all**, not even `idle`. With no cache entry it
  can never be fresh, so a labelled note would sit permanently `stale` — counted by the toolbar
  badge, re-offered by every Run, for a paragraph of prose.
- `Scheduler.execute` skips it, so it lands in neither `executed` nor `deferred`.
- The store's `needsRun` returns false (the palette's stale count reads through it), and
  `toggleDisabled`/`toggleCollapsed` filter it out. Collapsing is the dangerous one: a note draws
  no header, so a collapsed one would have nothing left to press.
- The inspector drops its Ports and Result sections; the context menu drops Run, Invalidate, Mute
  and Collapse; the palette disables Run Selected and Expand. Params stay — for a note that is a
  full-width editor for the same string, which is the better place to write more than a sentence.
- `NodeThumbnail` draws a framed box of text lines rather than a card with a header strip, so the
  browser tile does not promise sockets the inserted thing does not have.

**Read mode drags, edit mode types.** The rendered view is draggable everywhere, which is what
makes a note a thing you push around; the cost is that its text cannot be selected with the
pointer, since that gesture moves the card. Double-click swaps in a `nodrag` textarea. Blender
and ComfyUI make the same trade and it is the right way round — notes are moved far more often
than they are re-read a phrase at a time.

**Escape reverts through a ref, and that is not incidental.** Unmounting a focused textarea can
fire blur on the way out, so leaving edit mode is not a way to express "cancel" — the blur
handler would commit the very edit being abandoned. Escape sets `reverting`, blurs, and the blur
handler reads the flag and skips the write.

**The frame is the object, and it is quiet.** The paper is 1.13:1 against the light canvas, so
the _border_ is what says "a different kind of thing". Achromatic, and one value for both
themes: `#7d7b76` is the grey that clears the 3:1 non-text floor on all four surfaces it can
meet — 3.98:1 and 3.52:1 on the light paper and canvas, 4.16:1 and 4.43:1 on the dark pair.
`--text-muted` would have served except on the light canvas, at 2.99:1, which is exactly where a
note dragged onto empty space lives. Otherwise the card takes the node's own shadow and a
slightly tighter radius: a note belongs to the same scene, and what separates it is what it
lacks — header, sockets, state bar, footer.

**`outline` is inspector-only, and off removes the whole frame** rather than only the stroke:
border, paper and shadow together, because a paper card with a shadow and no border is still a
card, which is the thing being turned off. Three details are load-bearing. The border stays as
`transparent` so toggling does not shift the text by 1.5px in each direction; a _selected_ note
keeps its accent ring, since a frameless note that also vanished when you tried to pick it up
would be unselectable except by accident; and the frame comes back while the textarea is open,
because an edit needs a visible target. Absent means on, so a note saved before the param existed
keeps the frame it was drawn with.

**The text goes through `ui/markdown.ts`**, the same subset the Description card renders, rather
than a second parser. That module exists because a blurb from a foreign deployment must not be
able to become markup, and text pasted into a graph that is then shared has exactly the same
property — raw HTML stays text by construction.

**Every generated workflow carries notes** (`wizard/build.ts`, and the bundled examples did the
same before it), an overview above the chain and one per stage under it. They are placed absolutely rather than through `place`,
because the node grid is a row of pipeline steps while a note spans several of them. Their source
runs through `dedent`: the markdown parser only recognises a heading at the start of a line, so a
`###` indented to match the surrounding code is a paragraph beginning with three hashes.

Two existing tests had to learn what an annotation is, and the change is the assertion rather
than an accommodation: `wizard.test.ts` now expects `executed` to match the _dataflow_ nodes
and `graph.nodes` to be strictly longer, and `App.smoke.test.tsx` counts Run buttons against the
same subset. Counting a note as work is counting the comments in a program as statements.

## Pivot: a matrix and a wide table

`core.pivot` emits **both** shapes of one pivot. `Matrix` is what the heatmap and `Normalize`
take and is a dead end for every ordinary table op, since a matrix carries no schema; `Table`
is the same pivot wide — the row labels in a column named after the Rows field, then one
numeric column per column label — which is what makes a pivot sortable, filterable, joinable
and exportable as the CSV somebody wanted, with no second node in between.

**The table is reshaped from the matrix, not pivoted a second time.** `matrixToTable` in
`tableOps.ts` takes the finished `MatrixValue`, so the two outputs cannot disagree about the
aggregation, the labels or their order, and the data is walked once. It also means an absent
pair reads as `0` in both, rather than as a null the table half invented.

**The wide schema is observed, not derived, and this is the second legitimate use of
`observesOutputSchema`** after Raw Cypher. Its columns _are_ the distinct values of the
Columns field, so nothing short of reading the data can name them and `inferOutputs` may not
fetch (invariant 2). The lifetime is the same as Cypher's: unknown-shaped until the first run
and again after a reload, which reads downstream as "columns unknown" rather than as a table
with none. Note what that costs — the label column's name comes from a param and _is_ known,
but publishing it alone would be a schema that is half fresh and half stale, which is worse
than uniformly stale.

Consequently pivot is the one op in `tableOps.ts` with no `*Schema` half, and invariant 3 is
satisfied a different way: `pivot.test.ts` asserts the two outputs against each other, and
that removing the observation empties the picker on the node downstream.

**`Matrix` stays the first output**, so every saved graph keeps its socket positions, a link
dragged off the node starts there, and the footer — which summarises the first output — still
says `N × M`.

Two small things fall out of a matrix axis being labels rather than data. The label column is
`str` even when pivoted from `neuronId`, which still joins back against the numeric column it
came from because `joinTables` keys on `String(cell)`. And a column label colliding with the
row field's name is suffixed (`type`, `type_2`) rather than dropped, the same call
`joinedColumns` makes.

The other direction is `core.unpivot`, below — which is not this node run backwards, for the
reason that section opens with.

## Unpivot: the other direction, and what it cannot give back

`core.unpivot` folds wide columns into a `name`/`value` pair — `tidyr::pivot_longer`,
`pandas.melt`. It exists because tables arrive already pivoted: a published connectivity CSV
with one column per partner type, a spreadsheet with one column per timepoint, the wide half of
a Pivot in this graph. Everything else here reads a *long* table — `Group By`, `Filter Table`, a
Scatter's two channels, every categorical colour — so a wide one is a dead end until it is
folded.

**It is not Pivot with the arrows reversed, and the asymmetry is the aggregation.** A pivot
collapses several rows into each cell; unfolding that cell gives one row back, not the several.
`unpivot(pivot(t))` round-trips only where the pivot had one row per pair to begin with — and
even then the pairs that were *absent* come back as explicit zero rows, because `matrixToTable`
wrote 0 where the matrix had none. `Drop empty` does not remove those, deliberately: 0 is a
value somebody may have measured, and deciding here that it is really absence would silently
undo the call the pivot already made. Filter the zeros downstream, where the decision is on the
canvas.

**Two pickers with deliberately opposite defaults.** Fold columns is explicit and empty means
nothing is folded; Keep is derived and empty means everything that is not. That looks backwards
next to `pivot_longer(cols = …)` until you count what each costs when it is wrong. Folding is
what multiplies rows — the result is `rows x folded`, the "product of two independently-resolved
pickers" shape the pivot ceilings were written for — so it is the half that has to be *said*.
Keeping is lossless, so "whatever is left" is both the safe reading and what somebody means by
"the id columns". One consequence worth knowing, which `core.select` shares: a Keep list whose
only column has disappeared resolves to *empty*, and empty means everything again. The card says
"Missing column(s)" through `validateColumnParams`, and a schema that has merely not **arrived**
never reaches it — `resolveColumns` hands stored names straight through there.

**The value column widens where the folded columns disagree**, through the same `combinedDType`
the coalesce uses and for the same reason: a picker naming these columns *is* somebody saying
they hold one fact. `stackColumns` refuses the identical clash because there nobody said it —
two tables met under one column name by accident. The unit rides along only while every folded
column agrees on it, `stackColumns`' rule again. And the two new columns **yield** a colliding
name (`name`, `name_2`) where `combineLayout`'s result would take it and suffix the incumbent:
these are this node's own spelling of its output, the same standing as the stack's source column.

**Row-major**, so an input row's cells stay together — `tidyr`'s order rather than `pandas`',
which emits one folded column's whole block before the next. Either is defensible; what decided
it is that a Table beside the node is how somebody checks a reshape, and grouping by the input
row keeps that a single glance. The pandas emitter says so in a comment rather than sorting,
since the difference is order and not content.

Unlike Pivot, **the schema is derived rather than observed**: every output column is named by a
param or copied from the input, so a picker downstream fills before the first run. Pivot cannot
do that because its wide columns *are* the data.

## Connectivity similarity: Partner Vectors and Similarity Matrix

`neuron.partnerVectors` and `core.similarity`, both under `Add ▸ Analysis`. Together they take
a Connectivity result to the square matrix a Linkage or a Heatmap wants:

```
Find Neurons ─┬─ Connectivity(both) ─ Partner Vectors ─ Similarity Matrix ─ Linkage ─ Dendrogram
   Dataset ───┘        └──────────────────┘ Neurons
```

**There is no Pivot in that chain, and that is the design.** The obvious route is to pivot
neurons against partners and compare the rows, and it is the step that does not scale: a
thousand neurons against their partner *ids* is 150 million cells, past both `MAX_PIVOT_COLUMNS`
and the crash floor, where the connections that actually exist number about a million. A long
table already **is** that matrix, in the coordinate form every sparse library starts from — one
row per non-zero, carrying its two coordinates and its value — so `similarityOps.ts` reads the
long table directly and the wide one is never built. What comes out, observations against
themselves, is genuinely dense and small.

### Why the reshape is its own node

`neuron.connectivity` emits an **edge list**: every row is `preId → postId`, oriented the way
the synapse points, for the reasons `connectivityOps.ts` argues at length. The query neuron is
therefore in `preId` on a downstream row and in `postId` on an upstream one, and there is no
single column holding "the neuron this row is about". Assembling one out of the existing table
nodes takes a Rename, a Combine Columns and a Stack *per branch* — six nodes of plumbing before
the first real question — so Partner Vectors does it, with the aggregation folded in. No Group
By either.

Two ways to learn which end was the query, and the wired one wins. A `Neurons` table says so
outright and works at any hop count. Without one the `direction` column is read instead, which
records *how the traversal found the edge* — `downstream` means the row came back from asking
about `preId`, and `both` means both endpoints were at the same hop, so the edge is internal to
the seed set and counts for each end. That reading holds only at **hop 1**, where the frontier
still is the seed set, so the derived route drops the rest and says how many.

**The `out:` / `in:` prefix is unconditional.** A neuron that receives from a type and one that
projects to it are not alike for it, and without the prefix the two would land on one feature.
Applying it even for a single direction means two of these tables stack, and means a saved graph
does not change meaning when a Connectivity node upstream is switched from `outputs` to `both`.
`direction` and `partner` ride along as their own columns so the composite can still be filtered
on either half.

**An untyped partner falls back to its own id.** This is the em-dash trap met properly:
`labelOf` pools every absent value into one label, which is right for a pivot axis somebody can
look at and filter out, and wrong for a feature vector — a shared "untyped" feature makes two
neurons alike for both touching unnamed things. Dropping them is the other, explicit choice, and
it says that the vectors then no longer account for all of a neuron's synapses.

### The metrics, and the one pass

Five, and they cost **one accumulator between them** rather than five, which is `pivotTable`'s
rule about allocating per aggregation applied to an array that is `n²` floats:

| metric | per pair | per observation |
| --- | --- | --- |
| Cosine, Euclidean | `Σ aᵢbᵢ` | `Σ aᵢ²` |
| Pearson | `Σ aᵢbᵢ` | `Σ aᵢ`, `Σ aᵢ²`, and the ambient `F` |
| Jaccard (presence) | `\|A ∩ B\|` | `\|A\|` |
| Jaccard (weighted) | `Σ min(aᵢ,bᵢ)` | `Σ aᵢ` |

The sum is taken feature-first: held column-major, a feature's entries are exactly the
observations carrying it, so every pair that shares it is one nested loop and every pair that
does not is never visited. Total work is `Σ_f |column f|²` — see [limits.md](limits.md), where
that is also the number the warning is built on. The diagonal is skipped, so a feature only one
observation carries costs nothing at all; on connectivity keyed by partner id that is most of
the columns.

Everything that varies per metric — the option list, which of the three sums it needs, what its
cells are called, whether it has a similarity form at all — is one row each in a `METRICS` table,
the shape `AGG_OPTIONS` uses one file over. "Euclidean has no similarity form" had been written
out four times, and the fourth (the inversion at the end of the pass) is load-bearing rather than
defensive: without it a Euclidean matrix comes back as `1 − distance`, inside out and clustering
without complaint.

**Every value was checked against scipy on the dense form**, not against arithmetic done the
same way twice: `similarityOps.test.ts` compares to `scipy.spatial.distance.pdist`, and
`probe-py-helpers.py` makes the same comparison from the notebook helper's end. Pearson centres
over the **ambient** feature space, counting an absent feature as the zero it is — centring over
the features an observation happens to have would make two neurons with one partner each
perfectly correlated, and agrees with `pdist(..., 'correlation')` on nothing.

Not here: the Jarrell/Schlegel vertex-similarity score, which does not reduce to that table —
`min − C₁·max·exp(−C₂·min)` is evaluated over the **union** of two vectors rather than their
intersection, so it is a per-pair merge rather than a shared accumulation. It is a second
traversal, not a sixth row, and adding it does not change the module's shape.

### Two things that are easy to get subtly wrong

**Presence is applied after the repeats are merged**, not by handing in a column of ones. An
ungrouped table lists a pair once per connection, so a column of ones would sum to a connection
*count* wearing presence's name — which every metric but the presence Jaccard then reads as a
magnitude. Found by running the generated Python helper, where cosine answered 0.949 for two
observations whose supports are identical.

**The diagonal is written rather than computed.** Every metric is 1 between a vector and itself
(0 as a distance) except over an observation with no features at all, where the ratio is 0/0.
Left as zero that is a non-zero distance to itself, which is not a distance and which fastcore
clusters without complaining. The empty observations are counted and said out loud instead.

### What reaches Linkage

`MatrixValue.measure` is **set** rather than left blank, and that is what makes
`Similarity Matrix → Linkage` need nothing configured: Linkage inverts a similarity and leaves a
distance alone by reading exactly that field. Pivot genuinely cannot answer it — its cells are
whatever aggregation was picked — which is why clustering a pivot needs a Normalize in front of
it and clustering this does not.

Euclidean is the one metric with no similarity form, so its `Cells are` control is hidden by
`visibleIf`. A hidden param is excluded from the provenance key (invariant 4), so `evaluate`
cannot read it: `effectiveOutput` is the one place that exception is written down, and the node,
both emitters and the value label all go through it.

### The wide layout

The same node takes an id column plus a multi-select of numeric columns — an uploaded embedding,
or a `Pivot → Table` — behind a `Layout` enum with `visibleIf` pickers, which is `core.groupBy`'s
precedent for a param whose meaning depends on another. One node rather than two because they
answer the same question and differ only in where the features are written down; splitting them
would put "which metric" in two places. A zero reads as absent there, which matters only to
Jaccard (presence) — every other metric already treats a zero as contributing nothing.

## Filter Network, and why "Filter" became "Filter Table"

`net.filter` cuts a subgraph out of a network: pick some nodes, keep what is near them. That is
**not** what `out.network`'s own knobs do, and the difference is the point. `minWeight` / top-N /
hide-isolated rank globally and answer "what is worth drawing in this graph"; they would discard
the very node you asked about if it happened to be small. This answers "what is *near* this",
which is the question you have when you are reading a graph rather than surveying one.

Built for `Match Cell Types`' `Network` port ([comparative.md](comparative.md)), where the label
graph is thousands of nodes and the unit worth looking at is one **connected component** — that
being what the matcher decides on, so a component is the answer to both "why did these correspond?"
and "why did those not?". It takes any network, so it works the same on `net.build`'s output.

**Two ways to name the seeds and they union**, `collectLabels`' shape and its reasoning: a filter
row is what you reach for while looking at the picture, an optional `Seed` table is what you have
when the selection came from somewhere else, and a node that ignored one the moment the other
arrived looks broken in the way that takes longest to notice. The filter row goes through
`filterTable` — `Filter Table`'s own evaluate — so the two nodes sharing a name agree on what `>=`
means because it is one function. In the exporters that is `pyFilterMask` and `rFilterPredicate`,
extracted for exactly this and shared by both emitters in each language.

Three decisions inside the walk, all in [networkOps.ts](../src/nodes/lib/networkOps.ts):

- **`direction` is ignored twice over, and `expandSelection` decides both.** For a component,
  because one that respected arrows would be a *reachable set* — a different answer wearing the
  same name; the control is also hidden for that mode, so it leaves the provenance key
  (invariant 4). And on an **undirected** network, where `source` and `target` are an arbitrary
  order: `Match Cell Types` emits one, so honouring `downstream` there would walk half of each
  pair by construction order. That half cannot live on the param — `visibleIf` is handed
  `ParamValues` and cannot see what is wired — and putting it in the walk is also what makes the
  canvas agree with its own notebooks, since `nx.ego_graph` on an `nx.Graph` and `igraph::ego`'s
  `mode` on an undirected graph both ignore direction already.
- **An induced link needs *both* ends kept**, not either. A link to a node that is not drawn is
  an arrow into nothing — the difference between a subgraph and a fringe.
- **The degree roll-ups are recomputed.** They describe the graph, and this is a different graph;
  a node still claiming its old `degreeOut` is driving a size encoding that says something untrue
  about the picture beside it. `induceSubnetwork` and `filterNetwork` share `subnetworkOf`, which
  is where that happens, so neither can forget it independently.

  **It covers `net.build`'s four columns and no others**, and that is a real limit rather than an
  oversight to tidy: `ROLLUPS` is a list of names, while `mapperNetwork`'s `nNeurons` is *derived*
  on a label node and *intrinsic* on a neuron group, and `pathsToNetwork`'s `paths`/`hop` count
  over the whole route set. Which columns are graph-derived is a fact about the producer, and
  `NetworkValue` has no field carrying it — so narrow a mapper graph and its label nodes keep the
  neuron counts of the groups you removed.

**The rename.** `core.filter` → `core.filterTable`, label "Filter" → "Filter Table". Two nodes
called Filter on one canvas, one taking a table and one a network, is a palette entry you have to
hover to tell apart. The type id moved with the label, which broke every stored graph naming it —
acceptable only because Coda is pre-release with one user, and the last time it will be: a rename
after this needs a load-time alias kept forever.

## Adjacency: a matrix, and the same connections as links

`neuron.adjacency` emits **two outputs describing one fetch**, which is `neuron.roiConnectivity`'s
arrangement and `core.pivot`'s before it. `Matrix` is what the Heatmap takes; `Links` is the same
connections long — `source`, `target`, `weight` — so they sort, filter, join and export.

The `Links` port was added because a connection matrix was otherwise a **dead end for everything
that thinks in links**. Of the ten nodes that touch a `Matrix`, the four that consume one produce
a matrix (`Normalize`, `Heatmap`), a tree (`Linkage`), or a thresholded top-N table
(`NBLAST Matches`) — none an edge list. So `Adjacency → Build Network` was unreachable, and with
it every graph metric, every network layout and the whole `net.metrics` / `net.centrality` pair.

**`Links` is derived from the matrix rather than fetched again**, so the two cannot disagree about
labels, grouping or weights — ROI Connectivity's rule, applied in the opposite direction (it
reshapes its long fetch *into* a matrix; this reshapes its matrix fetch *into* long).

**Only the non-zero cells**, and that is the whole judgement in `matrixToLinks`. It looks like it
contradicts `core.unpivot`, which keeps zeros because "0 is a value somebody may have measured" —
and the two are answering different questions. Unpivot is handed an arbitrary wide table and
cannot know what a zero meant. Here the zero was *manufactured*: a matrix cell has to hold
something, so absence became 0 on the way in, which is exactly what ROI Connectivity says as it
does the reshape the other way ("in a *table* those rows are rightly absent — nothing was measured
— but a matrix cell has to hold something"). Dropping them going back restores the form the data
had. The size argument is the same fact from the other end: a matrix is dense by construction, so
keeping the zeros would emit `rows × cols` rows — 250,000 for a 500 × 500 adjacency, nearly all
zero — and `Build Network` would turn that into a complete graph with a zero-weight link between
every pair. That is not a large answer; it is a different one.

**Matching column names buy recognition, not resolution**, and this is worth knowing because the
opposite assumption costs a wrong graph rather than an error. `net.build`'s `Source` and `Target`
declare `default: ''`, which the resolver reads as "first compatible column" and not as "the
column with my name" — so on this table both land on `source`, every link becomes a self-loop, and
the network comes out with no edges between anything. `Weight` is `optional`, so empty stays empty
and every link weighs 1 rather than its synapse count. Set Target and Weight on Build Network.
`adjacency.test.ts` pins that behaviour, so if `net.build` ever gains named defaults the test is
what says the wire became zero-configuration.

**The exporters bind both ports**, and the two languages get there differently. Python emits the
long half from `_conn` — `fetch_adjacencies`' own connection table, grouped by the same key —
rather than melting the matrix back down, and the two agree because a connection table has no zero
rows to drop. R melts `neuprint_get_adjacency_matrix`'s result and strips the zeros, which is
`matrixToLinks` transcribed.

## Heatmap: the Order tab is data, the Colour tab is not

`out.heatmap` grew two things at once, and the split between them is the design. **Colour** —
scale, palette, printed values — is presentational: none of it enters the provenance key, so
restyling a four-million-cell picture is a repaint. **Order** reorders the matrix the node
*outputs*, so it is in the key, the tab says downstream nodes go stale, and a Table wired beside
the heatmap, the CSV export and the notebook all show what the card shows. The obvious
alternative — a sort that lives in the drawing — was rejected for exactly that reason: a picture
sorted one way beside a table sorted another is two answers to one question.

### The filter and the sort are one mechanism

Each is a list of matrix indices per axis, and `takeMatrix` is the single place a new matrix is
built from such a list — a filter keeps fewer lines, a sort keeps every line in another order,
either may be absent, and `orderedMatrix` on the Linkage node is the same call with one order
down both axes. That unification is what stopped the filter being a second matrix-rebuilding
loop. **The filter runs first**, and the sort is computed against what it left, because a row
total taken over columns somebody has just excluded is not the number they asked for; a test
pins that ordering with a case where the two disagree.

**The grammar is Explore's, narrowed to one term.** A plain term is a case-insensitive
substring, `/` opts into a regular expression with an optional closing `/`, and `!` or `-`
negates. `bareRegex` is imported from `neuronSearch.ts` rather than restated, because the fiddly
half is where the pattern *ends* — a second reader of that rule is how one box comes to search
for a trailing slash. The opt-in exists for the reason it exists there: cell-type labels are
full of metacharacters (`LC4(R)`, `SMP001(a)`), so a box that compiled every term would widen
itself silently. Verified by running the emitted R, where that label as a regex matches nothing
and as a literal matches one row — which is why `fixed = TRUE` is not a detail.

Only one term per axis, where Explore takes several ANDed: two substrings ANDed against a single
short label is almost always empty, which reads as a broken control, and the useful question
there is an alternation the regex already spells.

**Two warnings, two different states.** A pattern that will not compile leaves that axis whole —
a half-typed `/^LC[` must not empty the picture while somebody is still typing it. A filter that
matches nothing is honoured and the result is empty, because that is the honest answer to what
was asked; leaving the axis whole there would show a full matrix under a filter claiming to have
narrowed it.

### Four criteria, one plan

`nodes/lib/matrixShape.ts` is the headless half. A criterion produces an order for one axis;
`orderPlan` says which axes lead and which follows; `applyOrderPlan` permutes. Every criterion,
including the one that comes back from Python, goes through the same three steps.

- **`total`** is the plain sum of the finite cells, largest first. Not a magnitude, and that is
  deliberate: `Colour scale` is presentational, so the output cannot be allowed to read it. A
  matrix of log-ratios sorted by total is sorted by net sign, which the help says out loud.
- **`label`** is natural order — `LC4` before `LC10` — through `Intl.Collator({ numeric: true,
  sensitivity: 'base' })`. Both exporters carry a helper that agrees with it (`coda_natural_key`,
  `coda_natural_order`), checked on a label that *starts* with digits, where all three put it
  first, and on an 18-digit id, which the R helper zero-pads rather than casting because a double
  does not hold one.
- **`value`** is one row or column deciding the other axis. The key is **typed, not picked**: a
  matrix's labels are data decided by the run, and `T.matrix()` deliberately carries none, so
  an `enum` reading the schema has nothing to offer at edit time. A key the matrix does not have
  is a `ctx.warn` and an axis left as it arrived — invariant 5's corollary applied to a typed
  key, since an unmet control is not grounds for blocking the graph.
- **`cluster`** is seaborn's clustermap, and **not the Linkage node's clustering**. Linkage reads
  the matrix *as* the distances, which is right for an NBLAST score matrix and wrong for an
  adjacency; this reads each row as a vector across the columns and clusters rows by the distance
  between vectors, which is right for connectivity and meaningless for scores. The help says
  which to use when. It is `coda_cluster_order` in `pyodide/linkage.py` — the same `.py`, the
  same wheel, the same `leaf_order` call, a different question — and its three metrics are
  numpy rather than scipy, because scipy is not among the packages the bridge loads. Checked
  against `pdist` and `leaves_list(linkage(pdist(x)))` by `scripts/probe-heatmap-order.py`:
  distances to 1e-9, leaf order identical, both axes, all five methods, three metrics.

### "The other axis follows", and why by label

An Adjacency is square over one population and usually **not symmetric**, so the request that
motivated the tab was "sort the columns and put the rows in the same order" — otherwise the
diagonal wanders off and the picture stops being readable as a connectome. `followOrder` gives the
follower the leader's labels in the leader's new order, wherever the follower has them, then
everything the leader did not name in the order it already had. **By label and never by index**:
"the same order" means the same *neuron* in row 3 and column 3, and index-matching would silently
do something else on any matrix whose axes are not the identical list. On a matrix whose axes
share no labels — types down, regions across — following is a no-op, which is the honest answer
and why the switch defaults to on.

### A cheap node with a Pyodide call in it

`cost` stays `cheap`, and invariant 6 says that is a decision to make on purpose. The call is
local, it runs only when `clustering` is chosen, and a heatmap that needed a Run to sort itself
would be a viewer that stopped being live the moment somebody asked it to be useful. What it
costs: Pyodide's boot on the first use in a session, which any NBLAST or Linkage has already paid;
the `n × n` distance matrix, refused past `CRASH_FLOOR_BYTES` and warned about past
`LINKAGE_OBSERVATIONS_WARN` (the Linkage node's threshold, since it is the same single-threaded
clustering); and the buffer is a **copy**, for the reason `LinkageRequest.scores` records —
`callPython` transfers it, and the original is the upstream node's cached result.

### Two divergences from scipy, both said out loud

A cell nobody recorded is read as **zero** for the clustering, counted, and warned about — the
cells themselves are untouched. And a constant vector, which has no correlation, and a zero
vector, which has no cosine, are put at **distance 1 from everything**: unlike everything, at the
end of the tree. scipy answers `NaN` there and `linkage` then refuses the whole matrix; R's `cor`
answers `NA` and `hclust` does the same. Both exporters write the NaN as 1 before clustering
rather than reproducing the refusal, and say so in a note, because a zero row in a connectivity
matrix is a neuron with no partners among these columns — a thing with no profile, not an error.

### The palettes

Names in `nodes/lib/heatmapParams.ts`, hex in `ui/colors.ts`, which is `encodingParams.ts`'s
arrangement for the categorical sets. Two lists because they are two kinds of thing — a diverging
ramp has a middle — and two params so a choice survives toggling the scale and back;
`heatmapPaletteOf` is the one reader, so a name from the wrong list degrades to Coda's ramp
everywhere at once. The published ones are transcribed by a script from the installed matplotlib
and seaborn, and how they were measured is in [viewers.md](viewers.md); what matters here is
that every name was chosen to be spelled the same way in Python and in R's viridisLite or
ColorBrewer, so the exporters **name** the palette somebody picked. Coda's own two have no name
there, so `Blues` and `RdBu_r` stand in with a note saying so.

## Network Metrics and Network Centrality: two nodes because cost is a node property

`net.metrics` answers "what shape is this graph?" and `net.centrality` answers "which node
matters?". They are one subject and two nodes, and the split is not tidiness — it is invariant 6
read literally. `cost` is a property of a node **type**, not of a run, so a single node holding
both halves would have to be `expensive`, and then reading a graph's node count, link count and
density would need a Run. Those are the numbers somebody wants *before* deciding whether the graph
is worth running anything over.

So: `net.metrics` is `cheap` and everything on it is O(V + E) or measured and warned about;
`net.centrality` is `expensive` and runs only on Run. They compose — Centrality writes its columns
onto the network, so a Metrics card downstream plots betweenness beside degree without either node
knowing about the other.

**Three ports each, and the middle one is the interesting choice.** `Network` is the input carrying
on with the metric columns written onto its node table; `Node stats` is the same numbers as a plain
table; `Summary` is the graph-level row. The network port is what makes `size by clustering` in a
viewer a column picker rather than a second node — `values.ts` anticipated exactly this ("a future
Centrality node can simply append a column") — and the table port exists because "which neurons are
the hubs" is a question with an answer worth sorting, joining and exporting, not just looking at.

### The summary is one wide row

Long form — one row per metric — reads better on the card and is worse everywhere else. The useful
thing to do with this port is run it inside a `For Each` over five datasets and `Collect` the
results: wide gives five rows whose columns line up, so a bar chart of density across connectomes
is a column picker. Long would need a Pivot first, and a pivot's columns are named by its data,
which is the one shape `inferOutputs` cannot derive.

Both table schemas are **constants**, for `describeSchema`'s reason: a picker downstream fills the
moment the wire is drawn. The one asymmetry is deliberate — Centrality's *node* columns follow its
switches (a metric turned off is a column that is not offered, rather than a column of nulls a
picker would offer and never fill), while its *summary* is constant-width with nulls, because its
whole use is being stacked across runs and a Collect of five summaries whose columns depend on each
run's settings is five different tables.

### Self-loops count towards degree and towards nothing else

An autapse is a real link, and `recomputeRollups` already counts it in both `degreeIn` and
`degreeOut`, so this does too. But it is not a neighbour of itself: it cannot close a triangle, it
cannot join two components, and counting it in density would let a graph exceed 1 — which is not a
large number, it is a wrong one. Every structural measure therefore runs on the **undirected simple
projection** (unique unordered pairs, no self-loops) and the summary reports `selfLoops`
separately rather than hiding the discrepancy.

That rule is where Coda and networkx part company, and both places it happens were found by
running the exporters rather than by reading them: `nx.overall_reciprocity` divides by every edge
including the loops, and `nx.eigenvector_centrality` keeps them — so one heavy autapse becomes an
eigenvector all of its own, scoring 1.0 while every real hub in the graph rounds to zero. The
emitted helpers strip loops first and say so.

### The guard rails are raised in `evaluate`, and that is not a style choice

`networkMetrics` is memoised on the network object, and the **card calls it too** — from the
node's *input*, deliberately, so that the run and the card share one triangle count. The two
warnings started out inside that function, which looked equivalent and was not: the card draws as
soon as the upstream value exists, so on the ordinary chain it primes the memo first, with no
warner, and `evaluate` then gets a cache hit and warns about nothing. A guard rail whose firing
depends on which caller arrived first is not a guard rail.

So the library returns `triangleWork` and `dangling` on its result and the node warns from them —
`out.describe`'s arrangement, which computes its own cell count and warns before calling the
memoised `describeTable`. `net.centrality` matches it: `sweepSources(options, nodes) * links` is
computed in `evaluate` before the await, off the tables rather than off an index the node would
build only to discard. Both are still stated before the cost is paid, which is the rule that
matters ([limits.md](limits.md)).

### The metric columns are written over, never beside

`net.build` emits `degreeIn`, `degreeOut`, `weightIn` and `weightOut` itself, so a network arriving
here usually already has four of these names. Adding `degreeIn_1` beside `degreeIn` would give a
column picker two answers to one question, and the second would be the **stale** one — a network
narrowed by `mapperNetwork` or `pathsToNetwork` carries roll-ups neither of those recomputes.
Overwriting is `recomputeRollups`' own rule applied to a longer list — and it *is* that rule:
`foldNodeColumns` / `withNodeColumns` in [networkOps.ts](../src/nodes/lib/networkOps.ts) are the
generalisation, taking the column list as an argument, so both new nodes and the older roll-up
recomputation state the "keep position, write over" decision once. `net.metrics` says so with a
`ctx.warn` when the collision is on a name it does not own (a joined `component`, say), and stays
quiet for the four `net.build` always writes — reading `ROLLUPS` from `networkOps` rather than
retyping the four names, because a second spelling is how the exemption comes to disagree with
the set it names.

### The numbers are pinned against networkx, in a checked-in fixture

Every definition here has a plausible variant one line away — assortativity over excess degree
rather than degree, transitivity averaged per node rather than summed, betweenness normalised by
unordered pairs, clustering counting a reciprocal pair twice — and each variant produces a column
that looks entirely reasonable and is not the number anybody else's tool would print.

So `scripts/probe-network-metrics.py` builds one seeded graph, asks networkx for every metric, and
writes both to `src/nodes/lib/__fixtures__/networkx.json`. The two lib tests read that file, which
means the comparison runs in CI on a machine with no Python. Three departures are deliberate and
each is asserted rather than skipped: `clustering` is null rather than 0 on a node with fewer than
two neighbours (0 makes `meanClustering` a count of the leaves), `assortativity` is null rather
than `nan` where the correlation is 0/0, and the self-loop rule above.

Two definitions worth knowing because they are choices among standards:

- **Closeness is harmonic and incoming** — `Σ 1/d(u,v)` over everything that reaches `v`, over
  `n - 1`. Classical closeness is `1/∞` for any node that cannot reach everything, which on a real
  connectome is most of them, and the usual workaround (restrict to the reachable set) makes a node
  in a two-node island outscore a hub. Incoming because that is how networkx defines
  `harmonic_centrality`, and because it is the direction a sampled sweep can estimate: a walk from
  a pivot yields `d(pivot, ·)` for everything, which accumulates into the *target's* score.
  Backwards, and the exact and sampled columns would be two measures wearing one name.
- **Betweenness is networkx's normalisation exactly**, `(n-1)(n-2)` for directed and undirected
  alike — the undirected sum is *not* halved first, because that denominator counts ordered pairs
  and the double count is what makes it the right one. igraph disagrees, which is why the R helper
  scales by hand; off by a factor of two in a column of small numbers is not something anybody
  spots.

### Sampling estimates a mean and refuses to estimate a maximum

`Sample` sweeps from `k` seeded-random source nodes and scales by `n / k`, which is the standard
estimator and is unbiased for betweenness and harmonic closeness alike. `meanPathLength` comes off
the same pivots and is an estimate too. `diameter` is **null** whenever the sweep was sampled: a
maximum is not a mean, and a sampled maximum is a lower bound with no error bar — a number that
reads like an answer and is not one.

Every random draw is seeded (invariant 4): the pivots, and Louvain's random walk, which is why the
`rng` option is passed to `graphology-communities-louvain` rather than left at `Math.random`.
Communities are renumbered **largest-first**, exactly as `componentsOfEdges` numbers components, so
that "colour by community" and `resolveColor`'s frequency ranking agree by construction — otherwise
the biggest community gets whichever colour fell out of the merge order, and two runs of the same
data are two different pictures.

### Parallel links are merged before any path is counted

`net.build`'s "Merge parallel links" can be turned off, and a connectivity table then arrives with
one row per synapse group, so a pair can appear four times. Brandes counts *shortest paths*, and a
duplicated neighbour adds `sigma[u]` to `sigma[v]` once per copy — the same single path counted
four times, inflating every betweenness downstream of it, with nothing about the output looking
unusual. The merge **sums the weights and then inverts**: four 30-synapse links between a pair are
one 120-synapse connection, which is what merging upstream would have produced, so a weighted path
is the same length whether or not somebody left that box ticked.

### Both nodes export, and the exporters are checked by running them

networkx and igraph have all of this, so both emit real cells rather than a `TODO` — through
`coda_network_metrics` / `coda_network_centrality`, a helper per language. `pnpm probe:netexport`
runs Coda's implementation and both generated helpers over one graph and compares column by
column: 586 comparisons each, aligned on `id`. Three things are compared loosely and each is said
out loud rather than skipped — the two power iterations stop by different rules (1e-8, measured),
and a Louvain partition from a different implementation can disagree about every label while
scoring the same modularity. See [export.md](export.md).

## Group By: one aggregation, several value columns

`core.groupBy`, `Add ▸ Transform ▸ Group By`. Collapse rows onto their group keys and
aggregate. Output is the group columns, `n`, and one aggregate per value column, each named
`<agg>_<column>`.

**`Of columns` is plural, `Aggregate` is not,** and the asymmetry is the design rather than an
unfinished half. Several columns of the same *kind* of quantity is the case that recurs — `pre`
beside `post`, an input count beside an output count — and it costs one pass and one enum in the
provenance key. A different aggregation per column is a different node: it needs a list of
`(column, aggregation)` rows, which is `core.rename`'s shape (an `ids` param of JSON pairs plus a
card that draws them) and a differently-shaped cell in both exporters. `sum` of one column beside
`mean` of another is two Group By nodes and a [Join](#join-four-directions-and-one-key-column) on the keys today, which also makes it
visible on the canvas that both halves came from the same rows.

**A bare `columns` param is safe here where it was not for Rename**, and the reason is worth
keeping: nothing in this list is positional. Each name carries its own output name through
`aggColumnName`, so removing the second of three columns removes exactly `<agg>_<that column>`.
Rename's two parallel lists could not do that — deleting the second of three columns shifts every
name after it onto the wrong column — which is why *its* rows carry both halves.

**The value picker stopped picking for you, and that broke stored graphs on purpose.** `Of column`
was a `column` param on the declared default `''`, which resolves to "the first compatible
column", so a freshly-created Group By already had one chosen. `resolveColumns` has no such rule,
so the picker now starts empty and `validate` says `"sum" needs at least one value column` — which
is what `Group by` beside it has always done. It also means a graph saved by an earlier build
loses its value column: it stored `value` as the bare string `"weight"`, and the plural resolver
reads a non-array as nothing. Taken as a break rather than absorbed, because the alternative was
teaching the *generic* resolver a second spelling for one param's history, which is the shim
invariant 8 is about. It is loud — empty picker, warning on the card — rather than a wrong number.

**A repeated value column is folded away, not aggregated twice.** Both copies would be called
`sum_weight`, and a schema claiming two columns of one name is a table whose data has one; every
picker downstream would offer the duplicate. `aggValueColumns` is that rule and is shared by both
halves, which is also where `count` drops the value list entirely — `count` answers with `n`, and
`n` rides along with every aggregation anyway.

**A named-but-absent value column still throws**, where an absent *key* column is dropped. That
asymmetry predates the plural and is kept: `resolveColumns` has already removed anything a known
schema lacks, so a name reaching `evaluate` means the schema never arrived, and `getColumn`'s
sentence naming the column beats a quiet success on whichever of the others happened to survive.

**Both emitters write one named aggregation per column.** pandas' `.agg(**kwargs)` rather than
`.agg({col: fn})`, because the dict form produces a frame whose columns keep their *source* names
and so disagrees with `<agg>_<column>` the moment there is more than one; dplyr gets one
`summarise` argument each rather than an `across()`, because `.names = "{.fn}_{.col}"` reproduces
Coda's naming only as long as the function is passed under exactly that name. The golden's `join`
node carries two value columns for this reason — the shape that needed checking is the second
argument, not the first.

### A null is skipped, and a group with no values has no answer

The rules for an absence in the *value* column, which used to be three different answers from one
node and its two exporters over the same data.

**`mean` divides by the values, not by the rows.** `n` counts rows and always did; the denominator
is the count of finite values beside it. Dividing by `n` meant one null pulled the mean towards
zero without appearing anywhere — on `[10, null, 20]` the canvas said 10, the notebook said 15 and
the knitted document said `NA`. `pivotTable` in the same file has always kept its own `counts`
array, so Group By and Pivot could quote different means of one column.

**`min`, `max` and `mean` answer null for a group holding no number**, where they used to answer
`0`: a manufactured measurement sitting in a column of real ones, and indistinguishable from one.
`sum` still answers 0 there, which is not an inconsistency — a sum over nothing is the identity,
and pandas and R agree.

**`countDistinct` does not count an absence**, which brings it into line with `join` a few lines
away in the same function — that one has always skipped absences — and with `nunique`. An empty
string *is* counted: somebody typed it, and folding it into null would be the editorial decision
`join` declines to make about `DA?` and `da?`.

Four of the seven aggregations therefore need an argument in R that they do not need in Python,
because base R propagates an `NA` where pandas skips it. `sum`, `mean` and `n_distinct` take
`na.rm = TRUE`; `min` and `max` cannot, because `min(x, na.rm = TRUE)` over an all-absent group
answers **`Inf`** with a warning — a value that survives `is.na`, is not dropped by a `filter` and
plots off the end of an axis. Those two are generated helpers (`coda_min`, `coda_max`), and the
golden's second Group By node exists to reach one of them so `probe-r-helpers.R` can run it; the
other is pinned at the emitter in `export.test.ts`.

## Normalize

`core.normalize`, `Add ▸ Analysis ▸ Normalize`. Rescale a matrix by row, by column, against the
global maximum, or logarithmically.

**Every mode was written for synapse counts, and signed matrices reach it routinely.** NBLAST
describes its scores as "the value the Heatmap and Normalize already understand" and a mean NBLAST
score is negative between two arbors that are not alike; `Similarity Matrix` under cosine or
Pearson is the other route. `total > 0` and an accumulator starting at `0` read as guards and were
really assumptions, so an all-negative matrix normalised to a grid of zeroes and a row summing to
`-0.6` did too.

**An empty line and an unusable one are different, and only the second has no answer.** A row of
zeroes is *measured* — that neuron has no partners in this set — so it stays zero and draws at the
bottom of the ramp, which is what a reader of a connectivity heatmap already understands it to
mean, and is what this node has always done. A line that *holds values* and still totals zero or
less is the other thing: `+5` against `-5` divides to `±Infinity`, and a negative total inverts
every sign. Those cells come out empty, which `heatmapPlot`'s fold already routes to bucket `-1`
and draws as unrecorded, and the count is warned about.

**`max` takes the largest magnitude**, which is the same number as the largest value whenever
nothing is negative — so a matrix of counts is untouched — and keeps the sign and the [-1, 1]
range on one that is signed.

Both emitters follow, and the shape is the same in each: mask the total rather than filling the
quotient, then put an all-zero line back. `.fillna(0)` and `[!is.finite()] <- 0` were the old
endings and each reproduced the bug faithfully.

## Deduplicate

`core.dedupe`, `Add ▸ Transform ▸ Deduplicate`. `pandas.drop_duplicates`: name the columns to
compare on, and `Keep` decides which row of a repeated set survives — `first`, `last`, or `none`.

**It exists because the providers stopped deciding.** Measured against FlyTable's `main.info`:
58,340 rows, 56,309 distinct root ids, 1,089 neurons with more than one row, and one segment
appearing 104 times with its `side` reading left, center and center among them. That used to be
collapsed silently inside `shapeRows`; now it reaches the canvas, and this is the node that
decides what to do about it in a place somebody can see.

**`none` is a different question, not a third flavour.** `first`/`last` answer "one row per
neuron" and differ only in which row a Sort upstream put where; `none` answers "only the rows
nobody disagrees about", which is the conservative read when a repeat is a *conflict* rather than
a copy. That is `keep=False`, and it is the mode worth knowing about.

**Empty compares whole rows**, which is `drop_duplicates()`'s own default and `Select`'s reading
of an empty picker — so an unconfigured node answers "this file has exact duplicates in it" with
nothing set. A column that is *named* but absent is refused rather than dropped, `groupByTable`'s
rule: comparing on fewer columns than were asked for silently keeps **more** rows, which on a
table whose upstream schema moved reads as a dedupe that did not work.

**Row order is the input's in all three modes.** A row kept because it was *last* stays where it
was rather than moving to the end — pandas does the same, and a dedupe that also reordered would
be two operations wearing one name. Note the trap in the implementation: `lastAt.values()` is in
*first*-occurrence order, so the second pass walks the rows again rather than reading the Map.

**`rowKey` is shared with `groupByTable`** rather than written twice — the second-consumer rule,
and the two characters in it are the whole of its correctness. `\u0001` separates columns, so
`["ab","c"]` and `["a","bc"]` are different rows (the collision `uploads.ts` records for its own
content address); `\u0000` stands for a missing value, so a null is not the four-letter string
`"null"`, which a `str` column of somebody's annotation base very plausibly contains. Both are
mutation-checked, because both fail as a *plausible wrong table* rather than as an error.

**Not Group By**, which is the neighbouring control and collapses rows into an aggregate. This
keeps whole rows, so every column comes through with the value it had; that difference is what
stops the two being one node with a mode.

The R emitter is the one place in that file that leaves dplyr, and it says why: `distinct()` keeps
the **first** row and has no argument for the other two, where `duplicated(..., fromLast = TRUE)`
is exactly `last` and OR-ing both directions is exactly `none` — one idiom covering all three,
preserving row order, and needing no library. Python is `drop_duplicates`, with `subset` **omitted**
rather than passed empty: `subset=[]` compares on no columns, which makes every row a duplicate of
the first.

## Upload Table and Table from URL: somebody else's data

`core.uploadTable`, added from `Add ▸ Utility ▸ Upload Table`. A CSV of annotations, custom cell
types or an embedding, brought in from the user's own machine — the one node here with no inputs
and no data source behind it. `src/data/uploads.ts` is the module to read first; everything below
follows from the two decisions taken there.

**The rows never enter the `.coda.json`.** The node stores a `dataId` and the filename it came
from; the table itself lives in IndexedDB. Three constraints force it and each one alone would be
enough: `stableStringify` re-hashes a string param on **every** graph edit (CLAUDE.md already
flags a 110 kB Explore Dataset selection as a stutter risk, and a whole-dataset embedding is megabytes),
the autosave is `localStorage` at a ~5 MB origin budget with `saveAutosave` swallowing quota
failures by design, and a `ParamValue` is `number | string | boolean | string[]` — a table can
only ride in a graph as text.

**So a `.coda.json` sent to a colleague arrives without its rows, and that is the accepted cost.**
It is not hidden: the card says which file is missing and offers to pick it again, and `evaluate`
throws naming the file so everything downstream is `blocked` rather than quietly running on
nothing. The message names the _file_ and never the content hash, because a hash is not something
anyone can act on.

**Its own IndexedDB database, not `data/cache.ts`.** That module is a cache — expiry,
fingerprint-as-miss, and a `cacheClear` that drops everything. A table somebody uploaded is not
evictable; losing it to a cache clear is losing their data. Same call and same reasoning as
`store/library.ts`, and it cannot live beside that one because `src/store` imports `src/nodes`, so
a node reaching into the store would close a cycle. `src/data` is the layer nodes may import.

**Writes reject, reads resolve**, inherited from `library.ts`. Everywhere else here a storage
failure degrades silently, because failing to _remember_ is not failing to compute; an upload
inverts that, because there is nothing to recompute from once the `File` handle is gone. There is
deliberately no in-memory fallback: something that survives until the tab reloads is not somewhere
to put a file. The write waits for the transaction's `complete` rather than for its requests — a
quota failure lets the `put` succeed and _then_ aborts, so awaiting the request would report an
import that was rolled back.

**`dataId` is a content address, and that is what makes provenance work with no nonce.** It hashes
the schema and every cell, so re-picking a file you already imported produces identical params and
re-runs nothing, while a file differing in one value invalidates everything downstream. Two nodes
given the same file share one stored copy. Note the separator: the hash walks a joined string, and
without one a column holding `['ab', 'c']` and one holding `['a', 'bc']` both concatenate to
`abc`, so two genuinely different imports would share an id and the second would silently resolve
to the first one's rows. It is written as `'\u001f'` rather than typed, because a raw control
character in a source file is invisible to every reader and to `grep` — this cost a debugging
round trip when one arrived in the file by accident.

**`fileName` is `presentational`, which looks wrong on a param that is not a viewer knob.** It
cannot change a byte of what `evaluate` returns — `dataId` decides that, and two people importing
one file under two names hold identical rows. Leaving it in the provenance key means renaming a
file re-runs the node and stales everything after it for a reason nobody could see.

### The peek, and why `ID column` is an enum

The schema is not in the graph either, so `inferOutputs` — synchronous, and forbidden to fetch by
invariant 2 — reads `peekUploadSchema`, which answers from an in-memory mirror and, the first time
it cannot, starts the read that will fill it. Once per id, never once per peek, because inference
runs on every keystroke. When it lands, `reportUploadLearned` fires and `graphStore` re-infers
through the _same_ `afterSourceLearned` handler the dataset listings use: this is not a
data-changed event, must not schedule a run and must not autosave, all of which that handler
already gets right for exactly the same reasons.

So on a cold load the node publishes a bare `T.table()` for a moment — typed, so the wire still
connects — and fills its columns in a millisecond or two.

**That window is why `ID column` is an `enum` and not a `column` param.** An enum's stored value
reaches the provenance key verbatim; a column param's is _resolved_ against the available schema
first. Resolved against an empty schema and then against a full one, the node would key one way
before the peek landed and another way after — marking a node that had just run stale, and
invalidating everything downstream of it, on every single reload. `resolveColumn`'s rule 2 keeps a
chosen name and would have survived it; `resolveColumns` drops what it cannot find and would not.

**A miss is announced too.** Without that the card sits on "looking for the stored rows" forever,
and that is the one state that has to resolve into a sentence telling somebody to pick the file
again.

**The card's `useSyncExternalStore` snapshot is a revision counter, not the peeked value.** Both
"still looking" and "not in this browser" peek to `undefined`, so a snapshot of the value is
identical either side of the read landing and React never re-renders. Same idiom and same reason
as the store's `runVersion`. A test drives this; it is not otherwise observable.

### Reading the file

`data/csv.ts`, headless, the counterpart to `ui/export.ts`'s CSV writing. Everything is decided
from the text — delimiter, header, and each column's dtype — and there is **no options
argument**, deliberately. The settings a caller might pass are exactly the ones that would have to
be _stored_ to be honoured on a later run, which puts them in the provenance key and makes the
node's stored schema something that can drift from its stored rows. Detecting once at ingest and
keeping the finished table means the two cannot disagree; the cost is that a file whose shape is
undetectable has to be fixed rather than configured.

- **The delimiter is judged on consistency, not on count.** Counting occurrences picks the comma
  out of a tab-separated file whose text fields contain commas. A real delimited file splits every
  row into the same number of fields, so the candidate producing one field count across the sample
  wins. Semicolon and tab are not exotic: a spreadsheet saving "CSV" under a comma-decimal locale
  writes semicolons, and `to_csv(sep=)` writes tabs.
- **A header is text, and that is the whole rule.** The moment any field of row one parses as a
  number, that row is data. Both obvious extra conditions are wrong: _blank_ names cannot
  disqualify it, because `to_csv()` with an index writes `,a,b` and every such export would be read
  as headerless; _duplicated_ names cannot either, because `uniqueNames` already suffixes them and
  demoting the row instead puts the word "type" into the first row of the column it was naming. The
  remaining ambiguity — an all-text file with no header — resolves _towards_ a header, the same bias
  `pandas.read_csv` takes.
- **The suffixing is `uniqueName`, which now lives in `src/core/types.ts`.** It was hand-written
  here and again in `tableOps.ts`, and `src/data` may not import `src/nodes` (invariant 1), so the
  annotation providers were about to make it three — `ID_COLUMN_NAME`'s argument for `src/core`
  exactly. The two copies had already parted company on the case that matters: this one *counted
  occurrences*, which turns `a, a, a_2` into `a, a_2, a_2` — a collision produced by the very
  function that exists to prevent one. Probing for the first **free** name cannot do that.
- **A blank cell is null, never zero.** `Number('')` is 0, which draws a dense stripe of data
  nobody recorded along every axis downstream. Same trap `numeric()` in `encoding.ts` exists for.
- **A value that would not survive a round trip stays text.** `007` and `0012` are how a
  zero-padded code is written and reading them as 7 and 12 loses what made them identifiers; an id
  past `Number.MAX_SAFE_INTEGER` comes back a different number. The load-bearing half is that this
  vetoes the _numeric_ reading and not merely the integral one — without that `007` fails the
  integer test, passes the float test, and arrives as `7` anyway. Floats are exempt: `1.50` and
  `1.5` are the same measurement, where an integer's digits are identity.
- **One stray value keeps the whole column text.** A column that is 99% numeric with an `n/a` in
  it is a text column with a convention in it, and reading the rest as numbers drops that row's
  value silently.
- **`0`/`1` are integers, never booleans.** A synapse count of 1 is not `true`, and nothing in the
  text says which was meant.
- **Ragged rows are padded and reported, never dropped.** A trailing comma is routine in a
  hand-edited file, and losing the row silently is worse than a null in it. The count goes through
  the card's error channel once, at import, rather than becoming a permanent badge — it is a fact
  about the import, not about the node's configuration.

**Both size checks are made against `file.size` before a byte is read**, which is the same call
`pivotTable` makes when it checks label cardinalities rather than the array it is about to
allocate. By the time a table exists the tab has already stalled. Two tiers, because "large for a
spreadsheet" and "too large for a browser" turned out to be two orders of magnitude apart:
`UPLOAD_WARN_BYTES` (50 MB) says the parse will take a moment and reads the file, and
`MAX_UPLOAD_BYTES` (200 MB) is one of the few outright refusals left — see [limits.md](limits.md).

### The two controls

Both are applied _after_ parsing and both are lossless, which is what lets them cost no re-parse
and never disagree with the rows already stored. The pair lives in `tableOps.ts` as
`uploadShapeSchema`/`uploadShapeTable`, with `uploadIsNeurons` shared between them so the schema
half and the value half cannot disagree about the _kind_ either.

- **`ID column` renames the chosen column to `neuronId`**, and the output becomes Neurons. Nodes
  address columns by name — `out.profile` validates on it, Connectivity and Skeletons read it — so
  a file whose author wrote `root_id` cannot meet neuron data until it is renamed. A column that
  merely already held the name is suffixed (`neuronId_2`), the same call `joinedColumns` makes. Only
  `i64` and `str` columns are offered: a float is a measurement and a boolean is a flag, and
  offering either invites a Neurons table whose neuron ids are neither.
- **`Text columns` widens a column to `str`**, and never the reverse. Reading text as a number is
  where data is lost, and the parser's round-trip rule has already kept anything ambiguous as
  text — so this is for a column that is genuinely numeric and genuinely not a _quantity_, like a
  cluster label or a layer index, which has no business offering itself to a size encoding or being
  averaged. Null stays null: `String(null)` is the four-letter word "null", which would read as a
  value everywhere downstream.

`ColumnSchemaSource` grew a second argument for `Text columns` — see the Explore Dataset section, where it
came from. A column picker on a node with **no inputs at all** has nowhere to read a schema from
but the node's own params, which is what that argument supplies.

**`cheap`, despite reading a database.** `evaluate` is one IndexedDB read of an already-parsed
table and no parse at all, and there is no upstream, so it re-runs only when its own params change.
Same reasoning as `out.neuroglancer`.

**Known limit: nothing collects orphans.** Deleting the node leaves its rows in IndexedDB, because
nothing can tell whether another graph on the shelf still references them — and content addressing
means re-importing the same file reuses the entry rather than adding one. A "manage uploads"
surface is the answer when there is one; silently deleting somebody's data on a node delete is not.

### The URL variant

`core.tableFromUrl`, `Add ▸ Utility ▸ Table from URL`. The same CSV, fetched rather than picked.
It shares the parser and the shaping pair, so the two nodes cannot drift on what a delimiter, an
ID column or a text column means, and differs in exactly one property: **a URL is reproducible
and an upload is not.** So this one needs no storage at all — the graph carries the address, and
a colleague opening the file re-fetches it. What it gives up is working on a file that only
exists on somebody's disk, behind a login, or on a host sending no CORS headers. Neither node
supersedes the other, which is why both exist.

**`expensive`, which is invariant 6 in its plainest form.** The URL is a text field. Marked
`cheap` it would fire a request per keystroke, at whatever host was half-typed.

**`refresh` is not decoration.** A file at a URL can change under a fixed set of params, which is
exactly the hidden mutable state invariant 4 requires an explicit nonce for — the Dataset node's
own `refresh` is the precedent. Without it, re-running against an updated file hands back the old
table from cache with nothing to say so.

**The schema is remembered per URL, in a module map, rather than observed.** `observesOutputSchema`
is the obvious fit — the shape is decided by a remote server that inference may not call — and it
is _almost_ right. What rules it out is `Text columns`: a `columns` param finds its options
through `schemaFrom`, which is handed the node's inputs and params and deliberately **not**
`ctx.observed`. Widening it to see the observed schema would have inference resolving that param
against a schema the _scheduler_ cannot see when it computes the provenance key and resolves
`ctx.columns` — invariant 5's exact desynchronisation. A map keyed by URL is readable from all
four callers at once. Same lifetime as an observed schema (empty before the first run and after a
reload), same announcement idiom, and session-scoped on purpose: what a server returned is not a
fact about the document, and persisting it would let a saved graph claim columns nobody fetched.

**A cross-origin refusal and a dead host are the same `TypeError`**, because that is all a browser
gives — the constraint `data/precomputed/transport.ts` works around by trying and remembering.
So the message names _both_: the fix for one is nothing like the fix for the other, and saying
only "network error" sends somebody to check their wifi over a header their server never sent.
No proxy is offered, deliberately: `deploymentProxy` in `vite.config.ts` exists under a rule
refusing anything but https to a public host, and a general-purpose fetch proxy is an SSRF hole
aimed at whoever is running the dev server.

**`Content-Length` is checked before the body is read**, and the parsed length again after,
because a chunked response declares nothing. **A 200 that parses to no rows quotes what arrived** —
overwhelmingly a login redirect or a permissions page served as HTML, where "no rows" alone sends
somebody to inspect a file that is perfectly fine.

**`validate` warns about `http` rather than refusing it.** Whether it is actually blocked depends
on how this app is served, which is not knowable at edit time — the same call `Find Neurons` makes
about `limit: 0`. A scheme that cannot be fetched at all (`file:`, `javascript:`) is refused by one
rule rather than by a list of special cases.

### A redirect is a CORS hop, and it is the one that fails

The refusal names both a dead host and a cross-origin block because a browser reports them as one
opaque `TypeError`. The commonest cause is neither: **a redirect whose *first* hop carries no
usable CORS header**. `github.com/<org>/<repo>/raw/refs/heads/main/<path>` answers `302` with
`access-control-allow-origin:` **present and empty**, which matches neither the origin nor `*`;
a browser CORS-checks every hop of a chain, so it stops there and never reaches
`raw.githubusercontent.com`, which answers `200` with `access-control-allow-origin: *` and gzips.
Measured from a real page origin: the first throws `TypeError: Failed to fetch`, the second
returns 31,718,491 characters. The fix is to paste the redirect *target*, and it is worth
knowing because the URL that fails is the one GitHub's own UI hands you.

Nothing in the code changed for this; it is recorded because "is it the format or is it CORS" is
the first question anybody asks, and the header evidence answers it in one look.

## Type column, and combining several into one

Two names are Coda's rather than a backend's — `neuronId` and `type` (`annotationColumn` in
`data/annotations/types.ts`, and `TYPE_COLUMN_NAME` beside it). Every provider renamed onto the
first from the start; **the two import nodes now rename onto the second too**, which is the same
rule stopping being half-applied.

**They are a pair rather than a symmetry.** An id makes the table *Neurons* — the kind, the
socket, `uploadIsNeurons`. A type makes it *legible*, and missing it is entirely silent:
`typesOf` reads `type` by literal name, so a chain publishing `cell_type` leaves
`neuronType`/`partnerType` null on every connectivity row **while the schema still declares
them**, Explore Dataset's `PRIMARY = ['type', 'instance']` falls through to a guess, and Neuron Profile's type
roll-ups empty. Reachable on the case the feature exists for: FlyWire's published annotation TSV
names the column `cell_type`.

`renamedColumns` takes `[from, to]` pairs now and applies both in one pass, so a column cannot be
the source of one rename and the collision victim of the other. The first pair naming a source
wins, so the same column picked twice is the id — and both nodes' pickers withhold the id from
the type list, with `validate` catching the case a saved graph can still carry.

**Every column is offered as the type, unlike the id.** A rename is lossless whatever the dtype
and nothing downstream requires a type to be text, where offering a float as an *id* would invite
a Neurons table whose neuron ids are neither.

**The rename is not injective, and the annotation providers had to learn that.** `cell_type` and
`celltype` both become `type`, so a base carrying two of those spellings — or one whose own column
is literally called `neuronId` — maps two columns onto one name. Each shaper built its schema from
`annotationColumn`, seeded `data` from `schema.columns` so the second entry overwrote the first,
and pointed both targets at the surviving array: every row pushed into it twice and `makeTable`
threw `ragged columns — "neuronId"`, naming the one column that was fine, on a fetch somebody had
waited twenty seconds for.

`annotationColumns` is the rule for all **five** sites — `shapeRows`, `wideRows`, `pivotRows` and
both `peekColumns`, the last two because invariant 3 says the schema half and the value half must
agree and a collision resolved in one and not the other leaves a picker offering a column no table
has. It takes the id column's name first, then hands out the rest through `uniqueName`.

Note it needs **no `SHAPE_FORMAT` bump**, against that constant's own instruction, and the reason
is worth stating rather than assuming: the rule there is "the same reply would now produce a
different table". Every input whose shape changed here previously *threw*, so it was never cached;
every input that could be cached is byte-identical. Bumping would cost a 79 MB re-download to
invalidate entries that are provably unchanged.

### Combine Columns, and why it is a node

`core.combineColumns`, `Add ▸ Transform ▸ Combine Columns`. `dplyr::coalesce`, SQL's `COALESCE`:
the columns are tried in the order they were picked and the first holding a value wins. It exists
because an annotation dump routinely spreads one fact over several columns — FlyWire's carries
`cell_type`, `hemibrain_type`, `supertype` and `cell_class`, and a neuron missing the first very
often has one of the others.

**A multi-select on `Type column` was the alternative and is worse in three ways**, each of which
is about reach rather than taste:

- It would put the ability on **two** nodes, and want to exist on **four** — `annotation.caveTable`
  and `annotation.flyTable`/`seaTable` have exactly the same problem, and a SeaTable base with its
  type split across two columns would have no route to it at all.
- Coalescing is not a fact about types. `soma_side`/`side`, two id columns, two name columns: the
  same act, none of them reachable from a control called `Type column`.
- It is a large semantic act with an invisible result. On the canvas a Table beside it shows what
  came out; buried in an inspector multi-select, the precedence order is a thing you have to
  believe rather than read.

That is the annotation chain's own premise carried through — the socket takes an ordinary table
*so ordinary table ops can stand in it* — so `Type column` stays singular, mirroring `ID column`
exactly, and the general job is a general node.

**The picker already expresses priority**: `ColumnsField` appends in pick order and renders the
chips in that order, so the list reads left to right as "try this, then this" with no new UI.

Five rules, each of which produces a plausible wrong table rather than an error:

- **Null and blank are one absence.** `datasetStats.ts`' call, for its reason: a base publishes
  both for one thing depending on how it was edited. This is also exactly where the obvious
  spelling in each language goes wrong — `df[cols].bfill(axis=1)` and `dplyr::coalesce()` both
  read `''` as a value and stop the search, and FlyWire's TSV writes an unset `cell_type` as a
  blank field rather than as nothing. Whitespace is deliberately *not* trimmed: `" "` is odd data
  rather than absent data.
- **A result named after one of the picked columns replaces it in place**, which is the backfill
  case and the common one — `[cell_type, hemibrain_type] → cell_type` leaves the table with the
  columns it arrived with. Any other name appends, and a column merely already holding it is
  suffixed rather than overwritten, which is `renamedColumns`' rule and `joinedColumns`' before it.
- **Mixed dtypes widen to `str` rather than refusing**, which is the opposite of `stackColumns`
  and the difference is real: a stack meeting two dtypes under one name has found two different
  columns wearing it, where this picker *is* somebody saying these hold one fact. `i64` with `f64`
  is the one pair that reconciles without leaving numbers. A number reaching a text column is
  converted, or the dtype is a lie.
- **A column the schema lacks is skipped, not refused.** `groupByTable` refuses the same case
  because grouping on fewer columns silently keeps *more* rows; here it keeps fewer values, which
  the result column shows.
- **It warns and passes through when unconfigured**, never refuses — invariant 5's corollary, and
  the gap that let `out.barChart` carry a wrong refusal unnoticed for months for want of a
  node-level test.

`Source column` is optional and off by default, naming which input each value came from —
`core.stack`'s companion, and on a real chain it is how you find out that `hemibrain_type`
contributed two rows out of 139,248.

### Verified by running it, in both languages

`scripts/probe-cave-helpers.py` became **`scripts/probe-py-helpers.py`** (`pnpm probe:helpers`),
because a prefix naming one of two consumers is a claim that goes stale — the call
`.profile__tile` → `.tile` and `.labels-body` → `.list-body` already record. It now reads two
generated cells: the CAVE helpers out of `cave.ipynb`, and the general cell out of
`everything.ipynb` for `coda_combine`. It does not claim to cover the rest of that cell, and says
so.

Both languages were **run against the golden text**, not read: ten checks each — priority order,
blank-as-absent, null-as-absent, nothing-anywhere, a missing column, the source column, and the
widening — agreeing on all ten, R included, where R's widening happens by coercion
(`out[fill] <- col[fill]` on a logical `NA` vector) rather than by a rule anybody wrote. The
blank-as-absent mutation was confirmed to fail the probe.

And on the real file, through the real functions: the published FlyWire TSV parses as tab
(31 columns, 139,248 rows), `root_id` survives as `str` — the round-trip rule vetoing a *numeric*
reading of anything past `MAX_SAFE_INTEGER`, so an eighteen-digit id meets CAVE's string ids with
no conversion anywhere — and `[cell_type, hemibrain_type, supertype, cell_class]` takes 137,720
typed neurons to **139,166 of 139,248**, with 82 carrying nothing at all.

**+5.12 kB raw / +1.25 kB gzipped on the main chunk** (1,088.17 → 1,093.29 kB), measured against
a build of the same tree with the feature stashed out. Both emitters are in the lazily-loaded
`exporter-*.js` pair as ever.

**Not looked at in a browser**: the `Type column` dropdown and the chip order on a real card.
Both are existing components, so the standing of the WebGL viewers applies.

## Rename Columns

`core.rename`, `Add ▸ Transform ▸ Rename Columns`. Give one or more columns a different name,
leaving their values, dtypes and units alone.

**It is the general form of the two import nodes' `ID column`**, and that is the case it exists
for. Coda addresses exactly two columns by literal name — `neuronId` and `type` — so somebody
else's table, whose id is `root_id` and whose cell typing is `cell_type`, meets a Neurons socket,
a `typesOf` lookup or a Neuron Profile roll-up and quietly answers nothing. Upload Table and Table from
URL fix that at the point of import; nothing could fix it for a table that was **fetched** or
**joined**, which is what this is. `Table from URL → Rename Columns → Skeletons` is the chain.

**Renaming onto `neuronId` promotes to Neurons; renaming it away demotes.** The demotion has to
happen — the column is gone, so every downstream `idColumn()` would fail at run time on a kind
that is no longer true — and the promotion is what makes the node worth more than a cosmetic
tidy-up. What it will *not* do is promote a table it did not touch: `core.stack` states the rule
this respects, that a `neurons` kind is a **claim** the ids are neurons of a dataset and a plain
table which happens to carry a `neuronId` never made it. So the promotion needs an *applied*
rename naming the column, which is why the kind is read off `renamePlan`'s `applied` map rather
than off the pairs — a row naming a column an upstream edit removed has renamed nothing at all.

**`renamePlan` is the one analysis all four readers share** — the schema half, the value half,
the node's `validate` and its card. Computed separately it was the same walk two and three
times over per keystroke, and worse, the card and the badge answered "which columns are
missing" from two expressions free to drift apart. `resolveFilters` one node over has the same
shape for the same reason.

### The rows are a list, not a pair of params

A `columns` picker plus a matching list of new names needs no widget and is wrong in the way
that is hardest to see: the two lists are positional, so deleting the second of three columns
silently shifts every name after it onto the wrong column. A row carrying both halves cannot
come apart.

Stored the way `out.table` stores its filter clauses — an opaque `string[]` of JSON pairs
(`nodes/lib/renames.ts`), legible in a `.coda.json` — and for the same reason: a column name is
not a safe left-hand side for a delimited encoding, since a wide pivot names its columns after
label values and an uploaded CSV's header can hold anything at all.

**A blank row is component state, never a param.** `+ Add` draws a row and writes nothing:
`renames` is in the provenance key, so a row that renames nothing would mark the node stale and
everything downstream with it, for a control nobody has used yet. What the store holds is what
the run will do. A half-filled row — a column picked, no name yet — *is* stored, because that one
is a row mid-edit and dropping it would delete it from under the cursor on the next round trip.

**The column picker follows `ParamField`'s three-state rule and shares its widgets to do so.**
Unknown is not missing, and this node sits directly behind the node that makes that distinction
matter: `Table from URL` keeps its schema per URL in a session-scoped map, so a fresh session
publishes none. The always-present `column…` placeholder is what keeps the select out of
`SelectField`'s no-options branch, which renders *disabled* — the failure `columnField.test.tsx`
records, reached here from a second widget — and it doubles as the way back to unset.

### Nothing refuses; four things warn

Invariant 5's corollary: a node passing a whole table through has no business blocking every node
downstream over a half-typed row. So a missing source column, a blank target, two rows aiming at
one name, and the Neurons demotion are all warnings, and the run happens regardless.

**Two rows aiming at one name suffix the second**, which is `renamedColumns`' collision rule.
That function had to be generalised for this: the mapping **is not injective** and a widget lets
somebody express that in two keystrokes, where the import nodes' two renames have fixed and
distinct targets and could never reach it. Taking both literally emits two columns of one name —
`makeTable`'s ragged throw at best, a silently overwritten column at worst. It now allocates
every output name through one `uniqueName` set in two passes: renamed columns claim their names
first, so a column that only *happens* to hold a target name is the one that gets suffixed rather
than the one somebody chose.

### Both emitters, and the R trap

`df.rename(columns=…)` and `rename(any_of(c(new = "old")))`. Two facts behind those, each
verified against the real library:

- **`any_of` rather than a bare `rename`**, because bare `rename` **errors** on a column the
  frame does not carry (`Can't rename columns that don't exist`) where Coda's rule is that such a
  row renames nothing. `any_of` is the tidyselect form with pandas' tolerance.
- **R does not take a trailing comma in `c()`.** `c(a = 1,)` is `argument 2 is empty` — a
  parse-time error in a document knitr aborts on, not a stylistic wart. Python takes one in a
  dict, so the same shape one file over is perfectly legal, which is exactly how it got written.
  Caught by running the generated chunk.

**The mapping is resolved against the incoming schema before it is written out** (`renameMapping`),
so a collision comes out as the suffix Coda applies rather than as two columns of one name in
pandas or `rename`'s "Names must be unique" in R. With no schema — a Pivot upstream, a first run
— it falls back to the pairs as typed, which is the same answer whenever nothing collides and is
the honest limit of what can be known at export time.

### What it costs, and what was seen

**+6.70 kB raw / +2.19 kB gzipped on the main chunk** (1,163.87 → 1,170.57), measured against a
build of `HEAD` in a clean worktree — that covers the Join changes as well. Both exporter chunks
carry the emitters and `main` carries neither `renameMapping` nor the join scratch key.

Driven in a real browser over CDP against `pnpm dev`, since a four-column grid in a 320px card is
exactly what jsdom cannot see: both themes, two rows laid out at 130/9/130/18 with nothing
overflowing the card, `+ Add` growing it to 234px, the unwired card saying `Connect a table.`,
and no console errors. The one thing it showed that the tests could not is that
`cellBodyFiber (missing)` **truncates** in a 130px select — the marker is cut mid-word — so the
select carries its full value in a `title`, and the badge and the foot line both name the column
anyway.

## Edit Table: disagreeing with the data

`core.editTable`, `Add ▸ Transform ▸ Edit Table`. One row per rule — `where … set column =
value` — applied top to bottom. pandas' `.loc[rows, column] = value`, which is what it was
modelled on and, in the notebook, what it emits.

The node exists for the thing every annotation set eventually needs: a cell type somebody has
since revised, a status that is wrong for the twelve neurons you have actually looked at, a
grouping the dataset does not carry at all. Before it, each of those meant exporting a CSV,
editing it somewhere else and importing it back — at which point the graph no longer records
where the numbers came from, and re-running the analysis *without* the override is not a gesture
anybody can perform. Here the override is a node: unwire it and the comparison is on screen.

### An edit is a rule, not a cell reference

The alternative design — click a cell in the Table viewer and type — was the other half of the
TODO this closes, and it does not survive the first re-run. A Coda table is *derived*: fetched,
filtered, joined, re-fetched tomorrow against a proofreading server that has moved on. "Row 412,
column type" stops meaning anything the first time a filter upstream drops a row, and it fails
**silently**, because row 412 still exists and still has a type.

A rule survives all of that. It is also the half worth reading six months later: `where type==LC4
set type = LC4a` says what was decided, where a list of edited cells says only that something
was. Direct cell editing is still worth having as a way to *author* rules — click a cell, get a
row prefilled with the id — but the storage has to be the rule either way.

### The filter is Explore's grammar, borrowed whole

`where` is parsed by `parseSearch`, so `type==LC4 status==Traced`, `pre>100`, `!status==Traced` and
`type~^LPLC[0-9]+$` mean here exactly what they mean in the Explore search box and — through
`leadingOperator` — in a Table viewer's column headers. `tableFilter.ts`'s reason applies
unchanged: this app already had a filter language, and a second one is a second thing to learn
and a second thing to get subtly different. Blank means every row, which is `.loc[:, c] = v`.

### Everything errs towards editing *fewer* rows, which the Table viewer does not

This is the one rule to keep, and it inverts `tableFilter.ts`'s. There a clause that cannot be
applied is dropped and the table shows more rows than intended — acceptable for a tap. A dropped
term **here** widens what gets overwritten, so a rule whose filter cannot be resolved is disabled
outright and the reason is reported. Two cases look harmless and are not:

- **A bare term is refused.** `LC4` on its own means "any column contains LC4", which is right
  for finding something and wrong for overwriting it: `LC4` also appears in `instance`, in
  `notes` and in somebody's `group`. It has to be written `type==LC4`.
- **A filter naming a column the table lacks disables the rule**, where the same clause in the
  Table viewer merely matches nothing. Not the same thing, and the difference is one keystroke:
  `fieldTermsMatch` reads an unknown column as "did not match", so a *negated* term on one
  matches **every row** — `!typ==LC4` would overwrite the whole table rather than most of it.

Nothing refuses, though. Every failure is a warning and the table still passes through, which is
invariant 5's corollary in a node that has a whole table on its output.

### The schema is decided by `column` and `value`, never by `where`

A rule naming a column the table does not have **creates** it, null outside the rows it matches —
so this tags a set as readily as it corrects one. A value that does not fit the column's dtype
**widens** the column (`i64` → `f64` → `str`, never the other way), existing values converted.
Both are published by `editSchema` at edit time, so a downstream picker offers a column somebody
invented thirty seconds ago without waiting for a run.

The filter is deliberately outside that decision. It is the part being typed, and a column
blinking in and out of every downstream picker between two keystrokes of a regex is worse than a
column that exists slightly too early. So a rule with a broken filter still contributes its
column; it simply changes no rows and says so.

Widening in one direction is what makes it safe to apply *before* anything is written: no
existing value can fail to convert, so there is no order in which the halves could disagree.
`""` writes an empty cell — a real edit, clearing a status somebody disputes — and does **not**
widen, because null fits every dtype. A blank value field is a row somebody is still filling in,
and does nothing at all.

### Rules run in order, each seeing what the ones above it did

`.loc` lines in a script read that way and this is the same object, so the second rule's filter is
matched against the table the first one left — which is what lets one rule create a column and the
next narrow on it. The cost is that reordering the rows changes the answer, which is equally true
of the script.

### The `?`, and what it forced

`src/help/nodes/core.editTable.md` — the filter grammar as a table, four worked rules, and the
two cases that switch a rule off. Writing it was the occasion to *shorten* the node's `guide`
from 612 characters to 338, which is what `help.test.ts`'s 400-character ceiling is for: the
overlay prints the guide above the document under a **TL;DR** label, and a nine-sentence
paragraph labelled TL;DR is a lie about itself.

It also turned up a wrong claim one document over. `neuron.explore.md` said the search box
"combines multiple clauses with `AND` and `OR`, and uses parentheses to group them", with
`type==DNp02 AND (hemilineage==A OR hemilineage==B)` as the example. `parseSearch` has no such
grammar: it splits on whitespace and ANDs, so that query parses to a field term, the *literal
word* `and`, the bare text `(hemilineage==a`, the literal word `or`, and a term matching
`hemilineage` against `B)` — and finds nothing. Checked by running the parser rather than by
reading it, and corrected there. Which is the argument for one grammar rather than two: the
correction had to be made once, and every surface that borrows it is now describing the same
thing.

### The card, and the one number edit time cannot produce

Three fields to a line and `RenameBody`'s two rules: a blank row is component state rather than a
param, and a half-typed row is kept because it is inert. The column is a **text field with a
`datalist`**, not a picker — naming a column the table lacks is the gesture that adds one, and a
`select` makes it unreachable.

The foot line says *rows changed*, and it costs a pass over the input table. It is the only thing
on the card that can tell a rule that worked from a rule whose filter parses perfectly and matches
nothing, which is this node's characteristic failure and is invisible to `validate`. `evaluate`
raises the same thing as a `ctx.warn` per rule.

One trap the card ran into, which `FindNeuronsBody` had already written down: **a card mounts
before the graph it belongs to has loaded**, so seeding the blank-row count in `useState` computes
it against whichever node was there a moment ago and never revisits. Loading a graph whose Edit
Table has no rules, into a session that had one with three, drew a card with no rows at all — no
shape, just an Add button. The count is `undefined` until the first interaction and derived from
the store until then.

`RenameBody` had the same bug, live, on the same `+ Add` list, and it is fixed there too rather
than left as a third copy that had already drifted — which is the case `paramPairs.ts` cites as
this codebase's second-consumer rule. `renameBody.test.tsx` pins it with a load-a-second-graph
case, which fails against the seeded version. The three cards still each write their own list
machinery; that is the next thing to share, and the drift is the argument for it.

### Both emitters

`.loc[mask, "col"] = value` and `mutate("col" := replace(.data[["col"]], pred, value))`, over the
masks and predicates `out.table`'s header filters already compile. Two steps precede the
assignments in both languages and neither is optional, because the libraries would otherwise
differ from Coda about the **dtype** rather than about the values:

- **A widened column is cast first.** pandas 2 emits a `FutureWarning` and upcasts to `object`
  for an incompatible `.loc` assignment, and pandas 3 raises; `astype("string")` names the dtype
  the port publishes. Not `astype(str)`, which turns a missing value into the four characters
  `"nan"`.
- **An added column is created with its dtype.** In R that means a typed `NA` — bare `NA` is
  *logical*, so `mutate(group = NA)` gives a column whose type depends on whether any row matched.

R takes `replace()` rather than `if_else()`, which is not a style choice: `dplyr::if_else`
requires both arms to share a type and errors when they do not, which is precisely the case this
node exists for. `replace(x, i, v)` is `x[i] <- v` and coerces the vector exactly as Coda widens
the column. The target is written `"name" := …`, because a Coda column can be called anything an
uploaded CSV's header can be; dplyr re-exports rlang's `:=`, so nothing new is loaded.

A rule Coda disabled is left out of both documents and gets a `NOTE` saying so — translating it
into something that runs would edit more rows than the graph does.

**Verified by running it, in both languages.** The three-rule chain above was run against pandas
2.3.3 and against dplyr, on a frame with a null in it, and the two agree with each other and with
Coda: `LC4 → LC4a` on the one matching row, `group` created as `reviewed`/`<NA>`, `pre` carrying
`"1"`, `"unknown"`, `"3"` as text. The pandas run was made with `-W error::FutureWarning`, which
is the assertion that matters — it is what says the explicit `astype` is doing its job rather than
the assignment silently upcasting to `object` on the way to becoming an error in pandas 3.

## Select One: stepping through a collection

`core.selectOne`, `Add ▸ Transform ▸ Select One`. Forward and back through a table's rows, a
skeleton set or a mesh set, emitting the element you are looking at. The manual counterpart to
the `For each` in the TODO list — that would apply a sub-workflow to every element and collect
the results; this walks the same collection by hand. `Explore Dataset → Select One → Skeletons → 3D` is
the shape it exists for: one neuron of a result at a time, without editing a filter for each.

**Two indices, because browsing and deciding are different acts.** `index` is what the card is
showing and is presentational; `selected` is what the port carries and is not. That is Neuron Profile's
pager/pin split exactly, and it is here for the same reason: on a chain with an expensive node in
it, an arrow button that fires a full pass per press — and with auto-run on, fires it
_automatically_ — is not a browsing surface, it is a way to spend ten minutes of queries on a
gesture.

**`Live` is the opt-out, and it is presentational too.** Off, the arrows move `index` alone and
`Use this` commits. On, they move both, so the output follows the arrows — which is what anybody
wants on a cheap chain and exactly what they do not want on a costly one. The flag changes
nothing about what `evaluate` returns: `evaluate` reads `selected` and has no opinion on how it
got there. So it stays out of the provenance key, and toggling the mode invalidates nothing —
the same call `Download` makes about every one of its params. `selectOne.test.ts` asserts all
three flags through the scheduler _and_ on the params, because dropping one fails no type check
and the symptom (a graph going stale whenever somebody browses) reads as a scheduler bug.

**The choice is a position, not an identity, and that is a trade rather than an oversight.** An
index works on everything — a `groupBy` roll-up with no id column, an uploaded CSV of embeddings,
a mesh set — where the id-keyed selection `rowIds.ts` provides (Scatter's and Neuron Profile's) survives
an upstream re-sort but needs a column naming each element. What it costs is that reordering
upstream re-points the output. What it must not cost is a _silent_ wrong answer, which is why an
index past the end emits the **empty collection** rather than clamping to the last element: an
upstream filter that shrank the collection has not moved the choice, it has removed it, and
clamping would answer with a different neuron under the same number. Emptiness is a state every
downstream node already handles; a different neuron wearing the same index is not. The card says
so in words, naming the position and the length — "emitting nothing" alone reads as a broken node.

**`any` in, `any` out.** The type system cannot say "a table, skeletons or meshes", so the port
says `any` and the refusal is a validation question — the same call `out.profile` makes about
needing a `neuronId`. The output type is the input type untouched, so one row of a Neurons table is
still Neurons with the same columns and nothing downstream loses a column picker.

### What an iterable is

`nodes/lib/iterables.ts`, headless. Three value kinds are collections of independently meaningful
things: a table is rows, a `SkeletonsValue` is neurons, a `MeshesValue` is neurons.

**A `PointsValue` is deliberately not one.** It is the same shape — positions plus one attribute
row each — and stepping through it one synapse at a time is not a gesture anybody makes. That is
a judgement about the data rather than about the type, which is why the exclusion is a named list
rather than something falling out of a structural test.

**Taking one element preserves the kind and the schema**, which is what lets `inferOutputs` be a
pass-through. Only the counts change. The one thing that must **not** pass through is `bounds`:
they are a roll-up over the geometry, exactly as `degreeIn`/`degreeOut` are roll-ups over a
network's links, and a single skeleton still claiming the box of the twenty it came from frames a
3D viewer on empty space around it — which reads as a broken renderer rather than as a selection.
Same rule and same reason as `filterNetwork` recomputing its degrees. `detail` _is_ carried
through, because the level of detail is a fact about the fetch and taking one neuron out does not
re-fetch it.

`isIterableKind` is exported and used by both the node's `validate` and the card's foot line —
one list rather than one per caller, because two copies is how a node starts refusing a kind its
own card still offers to step through. `any` counts as steppable there: unknown is not a refusal,
the same distinction `columnSchemaFor` draws between an absent schema and an empty one.

### The card, and two things jsdom could not see

`SelectOneBody` is the pager, the commit button and the node's one non-advanced param. The foot
line is the whole of the design's honesty: with `Live` off, what is on screen and what is on the
port are two different elements for as long as somebody is browsing, so it always states which
element is being emitted.

Both of the following were found by pointing a real browser at it, and both are now pinned by
`selectOneBody.test.tsx` — which is the point, since neither throws:

- **"Connect a table" appeared on a card that was plainly wired.** Whether something is
  _connected_ is a fact about the graph and comes off the inferred **type**, which exists the
  moment the link is drawn; what is _on the wire_ is a fact about the last run and is absent
  until there has been one. Reading the second for the first sends somebody to fix a link that is
  already there — the same failure the exporter's unwired/blocked split exists to avoid. It now
  says `Not run yet.`
- **The Live checkbox was labelled twice.** `ParamField`'s checkbox draws its own label under the
  default `node` variant, and the generic card suppresses the row's label in **CSS**
  (`.param--wide .param__label { display: none }`) — so a body rendering both got "Live Live".
  The fix is `variant="inspector"`, which is what `ParamRows` already does and documents;
  borrowing the CSS half instead would drop the one boolean row out of the label column every
  other field in these bodies shares. jsdom applies no CSS, so the label **count** has to be
  asserted rather than looked at.

**One pre-existing bug came with it.** `.list-body` carried no padding, so all three cards using
it had their first few pixels painted over by `.coda-node::before`, the state bar down the card's
left edge — "ID column" read as "D column" on Input IDs and had done since it was written. It now
takes the same `calc(8px + var(--state-bar))` inset `.coda-node__params` does: a custom body
replaces the param band, so it has to replace its padding too.

**The Python emitter slices, never indexes.** `df.iloc[[i]]` and `nl[i]` both raise past the end
and both hand back a Series / a single neuron rather than a collection of one — where Coda emits
an empty collection of the same kind, and emits a collection either way. `[i:i+1]` is the one
spelling reproducing both, in pandas and in navis alike; the emitter branches on `ctx.inputType`
because a `NeuronList` takes it directly where a frame needs `.iloc`. The fixture carries **two**
Select One nodes for exactly that reason, or the golden file records only the half that happens
to be a DataFrame.

## Join: four directions, and one key column

`core.join`, `Add ▸ Transform ▸ Join`. Annotate the left table with matching rows from the
right. `Type` offers **left**, **inner**, **outer** and **right** — the complete set, and
`right` is not redundant with swapping the wires, because the output's columns stay in
left-then-right order either way, so nothing downstream has to be repointed to try the other
one.

**A duplicated key annotates; it never multiplies.** The side being *matched into* is
deduplicated first — the right for `left`/`inner`/`outer`, the left for `right` — first
occurrence winning. Which side that is flips with the direction, and getting it wrong costs a
row count rather than an error, which is why both emitters compute it rather than hardcoding
the right.

The consequence for `outer` is worth stating, because the obvious reading is the other one: a
**second** right row carrying a key the left also carries is *not* an unmatched row. It lost the
dedupe, and resurrecting it in the outer tail would reinstate exactly the multiplication the
rule prevents — drawn, worse, as a left-null row for a key that plainly matched. So "unmatched"
means *no left row carries this key*, never "this particular right row was not the one picked".

### The key column is one column, filled from whichever side had the row

The right key is dropped as redundant with the left's — it always has been — so a row arriving
from the right alone would otherwise have no key at all, which is the single most useful column
on it. It is filled from the right instead. That is exactly `dplyr::full_join(by = join_by(a ==
b))`; pandas keeps **both** key columns, and the notebook emitter rebuilds Coda's shape rather
than inheriting that. The alternative — keeping both, only under `outer`/`right` — was declined
because an output schema that changes shape with the join direction empties a downstream picker
every time somebody tries a different one.

**Where the two key dtypes differ, that column is reconciled by `mergedDType`.** Only `outer` and `right` can
put a right-hand key value into the left-hand key column, and only then do the dtypes have to
reconcile. Matching is by text already, so a `str` root id meeting an `i64` neuron id joins
perfectly well — but writing that string into a column *declared* `i64` breaks invariant 3, and
every picker, sort and formatter downstream believes the declaration. `mergedDType` is this
file's one statement of "can these two reconcile, and into what", so `i64` meeting `f64` stays a
number here exactly as it does in `stackColumns` and `combineColumns`, and only a genuine
disagreement goes to `str` — coercing to the left's dtype would silently round a wide id
(invariant 8). A left or inner join is untouched by it, which keeps the common case's numeric
sorting exactly as it was. `validate` names the resulting dtype on the card, because a column
changing dtype under every picker downstream is not something to discover after a run.

**Row order.** `left`/`inner`/`outer` keep the left's order, with the outer tail after it in the
right's. `right` keeps the right's throughout, which is what makes it the mirror of `left`.

### What was measured rather than assumed

The emitted code was **run against pandas 2.3 and dplyr 1.2 and compared row-for-row with
`joinTables`**, over all four directions and both key-naming cases. Three findings, each of
which was a plausible wrong answer before it was checked:

- **`drop(columns=[rightKey])` deletes the wrong column.** pandas suffixes the right key when
  its name collides with a left column (`postType_r`) and leaves it alone when it does not — so
  one spelling is right in one case and destroys the left table's own column in the other, with
  no error. The emitter renames the right key to a scratch name before the merge instead, which
  makes the drop knowable without needing the schema at export time. Same scratch-key idiom the
  label joins already use.
- **`left_on` and `right_on` naming the *same* column already produce one coalesced key column**
  in pandas, under `outer` and `right` alike — so the common case needs neither the fill nor the
  drop, and gets neither.
- **dplyr's `right_join` returns a different row *order*.** Coda emits one row per right-table
  row in the right's order; dplyr 1.2 puts matched rows in the left's order and unmatched right
  rows after them. The rows themselves are identical, so the chunk says so in a `NOTE` rather
  than contorting itself — reproducing the order needs a row-number column added, arranged on
  and dropped, in every right join.

**One pre-existing divergence was fixed on the way.** Coda has always dropped the right key
column; the Python emitter never did, so any join whose keys were named differently produced a
notebook with an extra column the canvas did not have. It was invisible because the fixture's
only Join used the same name on both sides — which is why the fixture now carries three.

## Relabel: the third way to combine two tables

`core.relabel`, `Add ▸ Transform ▸ Relabel`. `Join` widens a table with columns from another and
`Stack Tables` lengthens one with rows from another; this rewrites **values** in one column,
one lookup per row, and changes neither the row count nor the column count unless asked to.

It exists for [comparative connectomics](comparative.md) — a cross-dataset cell-type mapping is a
two-column table and applying one is exactly this — and `Compare Connectivity` will do the same
thing *internally* rather than demanding one of these upstream per dataset. It ships as a node
anyway because the co-clustering path has to relabel the feature axis of a Partner Vectors table,
and a second private spelling of one operation is how two callers come to disagree about what a
repeated key means.

**`Unmatched` is the parameter to read, and its default is the design.** A value the mapping does
not cover can be left empty, kept as it was, or have its row dropped, and the default is
**empty**. Keeping it is the friendlier-looking choice and the wrong one: an unmapped `LC4`
sitting in a column of cross-dataset labels is indistinguishable from one the mapper matched, and
every count downstream is then a count of two different things. `drop` is cocoa's
`ignore_unlabeled=True`.

Four rules that the obvious spelling in either language gets wrong while still answering:

- **The mapping's value column decides the dtype**, not the column being rewritten — relabelling
  type names through a table of cluster numbers gives numbers. `keep` is the exception, since it
  puts originals back in beside the mapped values; that pair widens through `mergedDType` exactly
  as a stack does, and the unit only rides along where every value came from the mapping.
- **A repeated key is used once, first winning.** Rows are never multiplied, which is `Join`'s
  rule and for `Join`'s reason.
- **Matching is textual**, through `rowKey` — the same cell rule `Join` and `Deduplicate` use, so
  a number and its text are one key and a null is its own key rather than a value that matches
  nothing. It does not rescue a wide neuron id that arrived as `i64`: that is a float64 and
  stopped being itself before it got here ([invariant 8](invariants.md)), which the card warns
  about because it otherwise reads as a mapping with holes in it.
- **A `Result` name the table already carries is suffixed**, never overwritten — except the
  relabelled column's own name, which means what leaving the field empty means.

Both emitters call a generated `coda_relabel` rather than inlining any of that, which is the
opposite of this area's usual standard and is why: four `.where` clauses per node, in a notebook
with several Relabels, is four copies of each rule. `probe:helpers` and `probe:r-helpers` execute
the generated source out of the goldens, so the rules are checked by running them.

## Stack Tables: the vertical Join

`core.stack`, `Add ▸ Transform ▸ Stack Tables`. `Join` widens a table with columns from another;
this lengthens one with rows from another. Two connectivity results from different seeds, a
hand-curated list added to a query result, the same analysis run on two datasets.

**Every column survives, and a gap is a null.** A column only one side carries is filled with null
for the other's rows — which is what null already means here: not recorded. The tidier
alternative, keeping only the columns both have, silently discards data that was wired in, and on
two neuron tables from different datasets that can be most of the columns with nothing on screen
saying so. Same call `Join` makes when it suffixes a colliding name rather than dropping it.

**A dtype clash is refused, not reconciled.** `neuronId` as a number above and text below is two
different columns wearing one name. Widening both to text keeps every value and removes the column
from every numeric picker downstream; coercing text to a number loses values outright
(`Number('n/a')`). Neither is a decision this node has grounds to make, so it names the column,
both readings, and stops. `i64` and `f64` are the exception and merge to `f64` silently: those are
the same kind of thing, and a count stacked onto a ratio is still a number.

The clash is **returned rather than thrown** by `stackColumns`, because both halves need it and
neither may throw — `inferOutputs` must not (invariant 2) and `validate` returns strings. Only
`stackTables` refuses, on exactly that list.

**A unit rides along only while both sides agree on it.** Nanometres stacked onto voxels is a
column with no single unit, and carrying one of them would label the other's rows wrongly.

**Rows keep input order and duplicates are kept** — `UNION ALL`, not `UNION`. Which of two
identical rows to keep is a real question with its own answer, and it belongs in the node that
asks it.

**Unknown until _both_ sides are known.** The result's column set depends on both, so publishing
the top's schema alone would advertise a table missing every column the bottom contributes, and a
picker downstream would be configured against a shape that never arrives. A dtype clash still
publishes the union using the top's reading — nothing is built from it, since `evaluate` refuses
on the same list, and it keeps the other columns pickable while somebody fixes the one that
clashes.

**Neurons only when both inputs are.** A `neurons` kind is a claim that the ids are neurons of a
dataset; a plain table that happens to carry a `neuronId` never made it. The type half and the value
half decide it the same way.

**Two inputs, chained for more**, exactly `Join`'s shape. Note the consequence for the source
column: it distinguishes the two inputs of the stack that _added_ it, so three tables want either
a distinct name per level or the labels set at each one.

**The source column is off by default and refused on a collision.** Empty adds none; a name adds a
`str` column holding `Top`/`Bottom`, or whatever the two labels say. Appended **last** rather than
first — it is this node's annotation, not part of either table, and pushing every real column one
place right on every stack reads as the data having moved. A name either input already uses is
refused rather than suffixed: the point of the column is to say where a row came from, and quietly
writing that into somebody's existing column is worse than untidy. The labels are `visibleIf` the
column is named, so naming the inputs of a stack that is not labelling anything cannot stale it.

Worth knowing that a genuine clash is reachable with nothing but built-in nodes, which is what
`stack.test.ts` uses: `core.pivot`'s wide table types its label column `str` even when pivoted
from an `i64`, so a pivot on `preId` stacked onto the connectivity table it came from disagrees
about exactly that column. Note also that the pivot publishes no schema until it has run, so
`validate` cannot see that clash at edit time and does not pretend to.

## Download: a side effect in a reactive graph

`out.download`, `Add ▸ Utility ▸ Download`. Write whatever arrives on the wire to a file. The one
node here whose _purpose_ is a side effect, and everything odd about it follows from that.

**`evaluate` does not download.** It passes its input through and nothing else. Two reasons, and
either alone would settle it: `src/nodes` is headless, so there is no `URL.createObjectURL` and no
anchor to click; and a cache hit means `evaluate` never runs, so a download performed there would
fire on the first Run and silently not on the second. `ui/useDownloads.ts` writes the file,
watching `lastRun.executed`.

**`expensive`, for a reason that has nothing to do with speed.** Nothing here is slow. But `cheap`
nodes re-run on the 180ms pass after every edit, and a node that writes a file per keystroke is
not one anybody can leave on a canvas. It also makes the signal reliable: only `runFull` records a
`RunSummary`, so the driver has something to watch.

**The signal is `executed`, never the output value.** A node that did not re-run is not in that
list, so a Run over an unchanged graph writes nothing — which is the whole of what bounds "on
every run". Watching the value would fire on a cache _restore_ too, writing a file for a graph
nobody re-ran.

**What it does not bound is auto-run.** With that on, every edit that changes the data upstream is
a full pass, and each writes a file. The card says so beside the checkbox, and that warning can
only live there: it depends on a **store** setting, which a node definition must never read, so
`validate` cannot express it.

**Every param is `presentational`, and that is the word used precisely.** `presentational` means
"cannot change what `evaluate` returns", and `evaluate` returns its input unchanged whatever the
filename, format or timestamp say — those decide what is _written_. Leaving them in the provenance
key made renaming a file re-run the node and invalidate the entire graph downstream of it, which
on an expensive pipeline is minutes of queries for a change to a string. The consequence, and it
is asserted rather than left implicit: **changing a setting and pressing Run writes nothing**,
because nothing re-executed. The card's button is what covers that, and is the reason it exists
beyond convenience.

**The driver is mounted in `Editor`, not in the node's card.** A collapsed card unmounts its body,
and a Download node that stopped writing when somebody tidied it away would be a bug nobody could
reproduce on purpose. It carries the mount-seeded guard `paletteRequest` uses, or a remount would
re-fire the last run's downloads — a file appearing because a panel was toggled.

### Pictures come from a viewer, not from the wire

A viewer is a **tap**: `out.scatter` passes its table on, never its picture, so nothing arriving on
this node's input could be an image. `svg`/`png` therefore read the rendered chart belonging to
whatever node _feeds_ this one, found from `graph.edges` rather than from a param — the wire
already names it.

**Reading the DOM would not work, and that is why `exportRegistry.ts` exists.** The heatmap and the
bar chart render a real `<svg>`, but the scatter draws to a canvas and the network to WebGL, and
both **synthesise** an SVG on demand (`scatterDraw`, `networkToSvg` over sigma's post-reducer
display data). Their picture has no element to query, so the viewer's own accessor is the only
route.

**The node id travels by context, not by prop**, which keeps this to two touch points instead of
sixteen: `ValuePreview` is the single place that dispatches to a viewer and already knows the node,
and `ViewerActions` is the single place every viewer converges on with its export source in hand.
`ValuePreview` is wrapped rather than having a provider at each `return` — it dispatches through
fourteen of them, and one missed would leave exactly one viewer unreachable with nothing failing to
say which.

The limit is real and the card states it: SVG and PNG work only while the upstream card is on
screen and not collapsed. Last registration wins, which is the useful way round — the overlay is
mounted last and largest, and is the one anybody asking for a PNG means.

### Formats

`ui/exportValue.ts`, and the rule is that **nothing is ever refused for want of a format**: a kind
with no natural text form falls back to JSON. An _explicit_ format the value cannot be written as
plans nothing and is reported, because silently falling back would hide that the choice did not
apply.

- **Table, Matrix, Points → CSV.** A point cloud keeps its positions with its attributes, since
  splitting them loses the row-for-row correspondence that makes it a point cloud.
- **Network Viewer → two CSVs**, nodes and links. One file cannot hold both without inventing a shape
  nothing reads; two is what the Network Viewer's own button gives and what Gephi imports.
- **Skeletons → SWC, Meshes → OBJ, one file per neuron.** A concatenated SWC has repeating ids and
  parses as one impossible tree. `MAX_MORPHOLOGY_FILES` caps the set at 50 and the plan _reports_
  the cap: a browser stops honouring downloads past roughly that many with no error, which reads
  as the export having half-worked.
- **Anything → JSON**, with typed arrays unpacked. `JSON.stringify` renders a `Float32Array` as an
  object keyed by index — valid, unreadable, several times larger — and every geometry value here
  is built out of them.

Two format details that produce a _valid file that is wrong_, which is why both have tests:

- **SWC ids are 1-based and a root's parent is `-1`.** Coda stores parents as array indices, so
  every one shifts. A 0-based file parses in every tool and hangs the first point off nothing. The
  structure identifier is written as `0` throughout rather than guessed — neuPrint publishes no
  soma/axon/dendrite labelling, and marking the root as soma would be a claim about anatomy the
  data does not support.
- **OBJ face indices are 1-based.** A 0-based file loads with one corrupt triangle and a stray
  vertex at the origin, which reads as a renderer bug rather than a bad export.

`downloadFiles` writes a multi-file set in a plain loop rather than staggered: browsers gate
multiple downloads from one gesture behind a permission prompt, and spacing them with timers loses
the gesture and gets them blocked outright instead of asked about once.

### One knock-on in the palette

An `any` **output** is excluded from the palette's backwards link-drag, and the asymmetry with the
input is the point. `any` on an input means "I accept whatever you have", which is a real answer to
"what could this feed?" — Download genuinely takes anything. `any` on an output means "whatever I
was given": a pass-through cannot _originate_ a Dataset, so offering it when dragging back from a
Dataset socket answers the question with a node that needs the same question asked again behind it.

## Copy IDs: the second side effect, and the one that cannot ride a run

`out.copyIds`, `Add ▸ Utility ▸ Copy IDs`. Takes **Neurons**, passes them straight through, and
puts their ids on the clipboard when the card's button is pressed. Download's shape, because the
constraints are Download's — `evaluate` does not copy (`src/nodes` is headless, and a cache hit
means it never runs at all), the write lives in the UI, and the card is a body rather than param
rows because the two things worth saying — *how many ids* and *whether a press would do anything*
— are decided from the **value**, which `validate` never sees.

Three places it departs from Download, each because the destination differs:

- **There is no `On run`, and the omission is the design.** A file can be written whenever the
  graph runs; a clipboard write cannot. Every engine but Chrome refuses `clipboard.writeText`
  outside a user gesture, so a run-triggered copy would work on one browser and fail on the
  others — and the failure is *silent in the worst direction*: the clipboard still holds whatever
  was there before, so the paste succeeds, with the wrong ids in it. The button is the only
  trigger.
- **`cheap`, where Download is `expensive`.** Download's cost is a safety property: it writes on
  run, and `cheap` would have it write a file per keystroke. Nothing here fires off a run at all,
  so the only thing cost decides is whether a node *downstream* of this tap gets its value without
  a Run — and a pass-through that made a chain need a Run it did not need before would be a tax
  charged for dropping a copy button onto it.
- **A `Neurons` port, not `any`.** Download takes anything because it writes the value; this node
  reads one column out of it. The question that settled it is the same one the `any`-output rule
  above asks: an `any` input here would advertise that a Network or a set of Skeletons could feed
  it, and neither has ids to copy.

The three settings — `Separator`, `Deduplicate`, `Quote ids` — are all `presentational` in the
strict sense invariant 4 requires: `evaluate` returns its input unchanged whatever they say, so
they decide the *text* and never the value. Leaving them in the provenance key would make changing
a comma re-run the node and invalidate everything below it, which on a chain fed by a connectome
query is minutes of refetching.

**The separator vocabulary and the joining rule are one table** (`nodes/lib/copyIds.ts`), and
**every reader comes through `copyIdsSettings`** — the node for its enum options, the card for its
button, and both exporters for the text they emit. That is `heatmapPaletteOf`'s arrangement, which
sits two imports away in the same emitter files: a headless `*Of(params)` resolver rather than a
table each surface indexes for itself. The failure it rules out is a separator the card offers and
a notebook does not honour; the two exporters are where that is silent, since their goldens compare
emitted text and would keep passing on either answer. It is keyed by a **name** rather than holding
the character, because the character is what the param would then store: `'\n'` in a saved graph
file, where a reader has to work out which control an escape belongs to. `joinIds` takes the ids
rather than the table, which is what lets the Network viewer's own **Copy ids** — a list in hand,
no table anywhere — use the same joiner. Two more rules live there and both are silent when wrong: deduplication keeps **first-seen
order** rather than sorting, since a Sort upstream is a decision; and `idColumn` is what reads the
column, so an 18-digit CAVE root id is copied exactly and a null — a left-joined `Neuron Set` row
— is dropped rather than pasted as a blank line.

**Both exporters emit a note, not a TODO**, which is the distinction `dataset.description` makes
for the opposite reason. `ctx.todo` means "no code came out of this" *and* "this step is missing":
the first is false, because withholding a tap's binding leaves every cell below a mid-chain Copy
IDs unbound, and the second is not the right reading either — the ids translate exactly. What a
notebook has no equivalent for is the *clipboard*, so the cell builds the same text, prints it,
and says why. It honours all three settings, because the emitted line is the one thing a reader
compares against the card.

## Skeletons: which copy, and saying which one answered

A dataset does not have *a* skeleton source. It has however many its publishers happened to put
somewhere, and they are different products rather than copies of one:

- `male-cns:v1.0` serves neuPrint's traced SWC **and** publishes a precomputed layer beside its
  segmentation. Same 1,688 nodes on body 45882, same nanometres — and only the SWC has radii.
- `minnie65_public` has a chunkedgraph level-2 cache **and** a populated CAVE skeleton service.
  7,167 vertices with radii against a few hundred chunk nodes, for the same neuron.
- `flywire_fafb_public` v783 publishes a flat bucket where its own declared service is empty, and
  it has no L2 cache at all — so the one route it has is the one nothing in CAVE's metadata
  mentions.

Until the `Source` control existed the node picked and said nothing, which mattered because
**cable length means something different down each route**. Two things changed:

- **`Source`, a dropdown built from `DataSource.skeletonSourcesFor`.** Its options are per
  *dataset* and arrive from probes `inferOutputs` may not await (invariant 2), so the list grows
  under you: a fresh session shows `Automatic`, and a moment later the same control offers three
  entries because `reportSourceLearned` re-ran inference. That is `peekMaterializations`'
  arrangement, and the alternative is a control that blocks the graph.
- **`SkeletonsValue.provenance`**, which is the same fact after a run — on the card's footer
  through `describeValue`, and in the 3D View's caption through `skeletonNote`.

Three rules about it.

**With one route the control still draws, reading `Automatic (neuPrint SWC)`.** That is the node
saying where its geometry comes from, which is the half of this feature that every dataset gets.
A blank "Automatic" is a provenance question mark on every graph anyone shares — the same reason
the Custom CAVE version dropdown names the materialization its blank entry resolves to.

**A pinned route the dataset does not have is reported, never substituted.** `validate` says so
at edit time and `fetchSkeletons` throws at run time, and the option stays in the list so the
card still shows what the graph says. Substituting is what a column picker refuses to do for the
same reason: quietly answering with a chunk decomposition where a traced reconstruction was asked
for changes every number downstream with nothing on screen to say so.

**The param is in the provenance key.** Not `presentational`: the route changes what `evaluate`
returns, so marking it presentational would leave one route's skeletons on screen under a card
claiming the other (invariant 4).

The routes themselves, what each costs and which backend has which, are in
[backends.md](backends.md). The ids are shared across backends — `published` means the same thing
on neuPrint, on CAVE and on a Neuroglancer Source node — which is what lets a pinned choice keep
meaning something when a Dataset node is repointed.

Both exporters carry a **note** rather than a refusal when the route is `published`: the cell
fetches neuPrint's SWC, because the published copy's URL is resolved from the dataset's
neuroglancer state at run time and the exporter has no network. What differs is said out loud —
no radii, and its own coverage. Same line the Meshes node's `Detail` draws against navis' `lod`.

## Synapses: what one point counts, and the confidence that was called a weight

Two bugs in one node, and they hid each other. Both were found by pointing Explore Dataset and a
Synapses node at the same neuron — `male-cns:v1.0` body 10001 — and noticing the numbers disagree:
Explore reported 1,015 pre and 18,582 post, and the node returned 13,617 points, every one of them
`post`.

### `Min weight` compiled to a confidence threshold, and its default excluded most of the cloud

`synapsesCypher` wrote `s.confidence >= minWeight`. `s.confidence` on a neuPrint `:Synapse` is a
predictor score in 0..1; the param was `kind: 'int'`, `default: 1`, `min: 1`. So the default meant
"keep only perfectly-confident synapses", and there was no value anybody could type that meant
"keep everything". Measured against the live servers:

| dataset | rows sampled | kept at `confidence >= 1` |
| --- | --- | --- |
| `male-cns:v1.0`, body 10001 | 19,597 (1,015 pre / 18,582 post) | 13,617 — **no pre at all** |
| `manc:v1.2.1` | 200,000 | 14,515, **no pre at all** |
| `optic-lobe:v1.1` | 200,000 | 12,641, **no pre at all** |
| `hemibrain:v1.2.1` | 200,000 | **213** |

On hemibrain the node was returning about a thousandth of the cloud. Three of the four datasets
returned no presynaptic site anywhere, because their pre scores top out below 1 (0.98 on male-CNS,
0.99 on MANC, 0.986 on optic-lobe).

It is now **`Min confidence`**: `kind: 'number'`, default `0`, which is off, and inspector-only.
Three consequences worth knowing.

**The type had to change with the name.** An `int` floored at 1 has no spelling for "off", and the
values that mean anything on neuPrint are all fractions.

**There is no `max`, because there is no shared scale.** neuPrint scores 0..1, CATMAID carries a
tracer's 1..5, and a CAVE datastack uses its synapse table's own column — FlyWire's `cleft_score`
runs to a few hundred and is cut by convention at 50. `SynapseRequest.minConfidence` records this;
the param's help says which scale is in front of you rather than pretending one exists.

**Two sources cannot honour it and now say so.** A CAVE datastack whose synapse table declares no
score column — which is every one but FlyWire, since Aedes has `size` (a cleft area, not a
confidence) and a merely *declared* table gets `STANDARD_SYNAPSE_COLUMNS`, which deliberately names
none — and the mock, which has no confidence at all. Both warn through `onWarn` and return
everything. Dropping it silently was defensible only while the default was 1 and excluded nothing;
a control that starts off is one somebody has *set* by the time it reaches a backend.

Nothing needs this most of the time: neuPrint applies the dataset's own floor at ingest.
`Meta.postHighAccuracyThreshold` is 0.5 on male-CNS, which is why nothing in that cloud scores
below 0.5004.

### Renaming the id is what carries stored graphs across

`normalizeParams` reads only declared params, so an old document's `minWeight: 1` stops being in
the provenance key, and the absent `minConfidence` falls to its default of off. That is deliberate
and it is not `absentMeans`' case: the third state `ParamBase.absentMeans` exists for is a param
whose absence meant something the default does not. Here absence and the default agree, and what
the old value meant was a filter nobody asked for.

### The presynaptic duplication the confidence filter was hiding

A neuPrint neuron holds one `SynapseSet` per partner *neuron*, and
`(n)-[:Contains]->(:SynapseSet)-[:Contains]->(s:Synapse)` therefore returns a presynaptic site once
per partner it drives. Postsynaptic densities belong to one connection each and are unaffected.

| dataset | pre rows | distinct pre synapses | factor |
| --- | --- | --- | --- |
| `male-cns:v1.0`, body 10001 | 4,491 | 1,015 | 4.4× |
| `hemibrain:v1.2.1` | 135,652 | 18,420 | 7.4× |
| `manc:v1.2.1` | 117,640 | 15,357 | 7.7× |
| `optic-lobe:v1.1` | 163,540 | 39,865 | 4.1× |

**The extra rows carry nothing that tells them apart.** `neuprint/schema.ts` drops `partnerId` from
the synapse schema on purpose — resolving it turns one query into a heavy join — so those rows are
the same neuron, polarity, confidence *and coordinate*, repeated. They were weighting a
multi-partner T-bar 4–8× in syNBLAST and in every per-neuron density measure, with nothing anywhere
looking unusual. neuprint-python hits this too and fixes it the same way, `WITH DISTINCT n, s`,
carrying the same comment (`queries/synapses.py`).

### `Rows`, and why it is Automatic-plus-two rather than a checkbox

The fix could not be "always deduplicate", because the three backends do not enumerate synapses in
the same currency, and only one of them has a choice:

| backend | what one row is | `links` | `sites` |
| --- | --- | --- | --- |
| neuPrint | site × partner neuron | ✓ | ✓ (`WITH DISTINCT n, s`) |
| CAVE | one predicted pre→post link | ✓ | ✗ — no site identity exists |
| CATMAID | one connector | ✗ — needs a second POST | ✓ (already) |

CAVE's synapse table has no key that identifies a presynaptic site: `pre_pt_supervoxel_id` names a
supervoxel, which is a chunk of segmentation and not a T-bar. CATMAID's
`connectors/links/?relation_type=presynaptic_to` answers one row per connector — measured on FAFB
skeleton 16 as 1,709 rows and 1,709 distinct connectors — so its natural unit is *already* the
site, and `links` is what it cannot answer without asking `connector/skeletons` for each
connector's postsynaptic partner count.

So **neither unit can be the default everywhere**, and the control is `skeletonParams.ts`' shape:
`Automatic` plus whichever units the source has, with the same rule that a pinned unit the source
cannot serve is an **error, never a substitution** — swapping it silently changes what a row counts.
`DataSource.synapseUnits` is the declaration, best first, and `resolveSynapseUnit` reads both halves
so the dropdown's `Automatic (…)` label and the branch the fetch takes cannot part company.

**It is resolved once, at the node, and `SynapseRequest.unit` is required.** That is the one place
this departs from `requireSkeletonRoute`, which each source calls for itself — and it departs
because the two questions differ in kind. A skeleton route has a live per-*dataset* half each source
has to answer regardless (CAVE still refuses `published` on an unflattened materialization), so the
vocabulary check rides along on a check that must be there. A unit varies with nothing, so the same
arrangement gave three backends a copy that re-derived a static fact the single caller already held
and **discarded the answer**, plus a fourth place for a new backend to forget — the exact trap
`requireSkeletonRoute`'s own docstring records. `fetchSynapses` has exactly one caller; making the
field required means it is the only door, and a source implementing the method without declaring
units is a compile error rather than a silent substitution.

Two smaller consequences. The refusal is **one sentence two layers render** — `synapseUnitRefusal`,
shared by the node's `validate` and its `evaluate` — because written separately they promptly said
`“sites”` and `“one row per site”` about the same refusal, which is `UNIT_LABELS`' own rule broken
between its own two readers. And `synapseUnits` is a **non-empty tuple**, so `[0]` always has an
answer: an `[]` a source could otherwise declare read as "nothing has said" to the dropdown and as a
hard error to the resolver, which is a clean-looking card and a confusing throw.

**Not done: the unit does not ride on the value.** `PointsValue` has no provenance field where
`SkeletonsValue` has one, so nothing says which unit answered after a run, and syNBLAST — which
takes two `T.points()` ports — cannot notice it has been handed a `sites` cloud and a `links` cloud.
That is the same 4.4× inflation this section is about, arriving through a door left open. The fix is
`PointsValue.unit`, stamped where the unit is resolved and read by the card caption and syNBLAST's
`validate`.

**`sites` is what Automatic takes wherever it is available**, which means on neuPrint. That is the
one free variable in the design and it went to `sites` because neuPrint's surplus rows are
duplicate coordinates rather than per-connection data — see above — and because deduplicated, the
count agrees with `n.pre`, with Explore Dataset, and with what both exporters emit. `links` stays
reachable in one click for anyone who wants the cloud weighted by connection.

Two differences from the skeleton control, both because the question is a different kind of
question. A skeleton route is a live fact about a bucket somebody published, so its list is per
dataset and grows under the user as probes land; a synapse unit is a property of the backend's
*transport*, known the moment a source is on the socket — which is why `synapseUnits` is a static
property rather than a method, and why `synapseUnitProblem` can complain immediately. And the named
units are listed only where there is a choice: offering CAVE a `sites` entry whose only outcome is
an error is a control with one working setting.

### The exporters had always disagreed with the canvas, in both directions

Neither emitted `minWeight` at all, so the notebook and the knitted document returned the whole
cloud where the canvas returned a third of it. The goldens compare emitted *text*, so nothing in
the suite could see it.

They are asymmetric now, and each says which way it diverges:

- **Python.** `SynapseCriteria` takes `confidence=`, so a set threshold is emitted — and an unset
  one emits *nothing*, which is not the same as `confidence=0`: the default is `None`, which
  neuprint-python resolves to the dataset's own `postHighAccuracyThreshold`. Writing `0` would
  disable a floor the canvas leaves in place. `fetch_synapses` always de-duplicates and there is no
  argument to stop it, so `sites` needs no emitted argument and `links` gets a note.
- **R.** `neuprint_get_synapses` has neither: no confidence argument (a TODO naming the `subset()`
  to write) and no `DISTINCT` in its query, which makes it the `links` unit — so on this side it is
  the *default* that diverges, and says so.

The fixture carries a **second Synapses node** for the reason it carries two NBLAST nodes: both
emitters branch on these two controls, and the first node takes neither, so with only it the
goldens pinned the branch that emits nothing.

## Connectivity: hops and direction

`Direction` offers `both`, and `Hops` traverses further than one synapse. Both changed what the
node _emits_, which is the part to read before touching it.

**The output is an edge list, not a partner list.** Columns are `preId`/`preType` →
`postId`/`postType`, plus `hop` and `direction`. Every row is oriented the way the synapse
points, always, so `Build Network` with source `preId` and target `postId` is correct for every
combination of params with nothing to think about. The old query-relative shape
(`neuronId` = the neuron you asked about, whichever way the arrow went) cannot survive either
addition: a `both` result mixes in-edges and out-edges, so half a network's arrows come out
backwards, and past one hop "the neuron you asked about" is not a thing a row can name — it is
whatever the previous hop reached.

**The `DataSource` seam did not change, and that is deliberate.** `fetchConnectivity` still
answers query-relative, because the Neuron Profile widget reads it directly through
`profileStats.ts` — "these are my upstream partners" is the right shape there and the wrong
shape here. The reorientation lives in `nodes/lib/connectivityOps.ts`, i.e. in the node.

**`hop` and `direction` are always present**, even at one hop downstream where they are constant.
A schema that gained and lost columns as Hops moved between 1 and 2 would silently clear every
downstream column picker pointing at them.

The rename is a breaking change and was taken as one: both bundled examples group by
`preType`/`postType` now, and a graph saved before this loses its column params on those two
names. Nothing repairs it — `validateColumnParams` reports the drift and the picker is re-chosen.

**`both` expands both ways at _every_ hop — the undirected ball, not two cones.** That is what
finds the neurons sharing input with a seed (up then down) and its co-inputs (down then up),
which is usually why anyone asks for two hops in both directions. The cost is that the frontier
grows by in-degree × out-degree per round.

**Edges are deduplicated on (pre, post), and that is not tidiness.** With `both`, an edge inside
the frontier comes back from each end, and `Build Network` sums the weight of every row joining a
pair — so a duplicate row is a doubled synapse count in the picture. `direction` is `both` when an
edge was reached from each end **at the same hop**, which on a seed set is exactly the set of
edges internal to it. An edge re-found at a later hop keeps the direction and the hop it was first
given; otherwise the label would drift with traversal order rather than saying anything about the
graph.

**Neurons are expanded at most once.** Connectomes are full of recurrent loops, so a BFS that
re-expanded a visited neuron would not terminate. The _edge_ back into a seed is still reported;
only the neuron is not re-queued.

**`minWeight` is the only throttle, and it prunes rather than filters.** It is applied by the
source, so an edge below it is never returned — which means it is neither a row nor a reason to
expand. Three hops at weight 1 is a genuinely large question and is asked as one; `validate` says
so above three hops as a **warning**, never a refusal, the same call `Find Neurons` makes about
`limit: 0`.

**Iterative frontier queries, not a variable-length Cypher path.** `-[:ConnectsTo*1..N]->` is one
round trip and was declined: it hands the whole expansion to a shared production Neo4j with no
chance to prune between hops, it would put a `hops` field in `ConnectivityRequest` for a concern
no source should own, and `MockSource` would need its own BFS regardless. Looping
`fetchConnectivity` instead means no source changed at all, the mock works for free, the BFS is
testable against a fake graph with no network, and progress can report per round.

**Known limit: the frontier is inlined into the query.** `idList` puts every id in an `IN`
list, so a hop-2 frontier of tens of thousands of neurons builds a very large Cypher string. Not
chunked, because chunking is only worth writing once a real query has actually failed on it — but
it is the first thing to suspect if a deep traversal errors at the transport rather than timing out.

### `Include fragments`, and why the far end stopped being bare

`Include fragments` chooses between the neurons a dataset publishes and every body a synapse
lands on. **A checkbox rather than a two-option enum**, because the two are not peers: one is what
nearly everybody wants and the other is an addition to it. What "proofread" means is deliberately
not restated on the card — it is whatever the Dataset node's population says, which is the point of
asking `findNeurons` rather than compiling a predicate of our own.
Measured on `male-cns:v1.0`, five `LC4` neurons downstream at weight 1 — read off the server, not
estimated:

| far end | distinct partners | edges | synapses |
| --- | --- | --- | --- |
| bare node — what the query always did | **4,252** | 4,889 | 11,898 |
| `:Segment` | 4,252 | — | 11,898 |
| `:Neuron` | 496 | 1,043 | 6,533 |
| `superclass IS NOT NULL` (male-CNS's own default) | 492 | 1,032 | 6,503 |

**Matching bare was right and was the wrong *only* option.** `connectivityCypher` matches the far
end as a bare node because a partner may be a `Segment` below the neuron threshold, and excluding
those under-reports the weight — which is exactly what `Normalize`'s two bases exist to measure.
What that reasoning never justified was having no other setting: 88% of the result was bodies the
`Neuron Set` port beside it could not find a single row for, and 45% of the weight went to them.

**It is a `findNeurons` lookup, not a clause.** The filter does not reach `ConnectivityRequest` at
all. `traverseConnectivity` takes a `published` callback, the node implements it as an ordinary
`findNeurons` keyed by the ids a hop reached, and an edge survives only if **both** ends came back.
Three things fall out, and each is why this shape beat compiling a predicate into the connectivity
query:

- **"Published" means exactly what `Find Neurons` means**, on every backend, because it is the
  same call. A `ConnectivityRequest` field would have been a second definition of one set, lowered
  five times — and the `Neuron Set` port beside it is precisely the thing that would then disagree.
- **No capability matrix.** `findNeurons` is required on `DataSource`; `fetchConnectivity` is not
  uniform enough to have carried this. Even the attached-edge-set arm works, since the dataset
  behind it still has a neuron table.
- **The dataset card's population reaches it**, through `neuronSetRequest`. That is the documented
  rule this deliberately amends — see `neuronSetRequest`'s own comment for the exception and its
  measurement.

The price is a round trip per hop and a connectivity response that still carries every fragment
before they are dropped. The saving is the hop after: a frontier of 492 rather than 4,252.

**Seeds are exempt.** They were named explicitly, and dropping every edge of a body somebody pasted
in is the substitution `Input IDs` refuses when it declines to apply a status filter.

**It bounds the frontier, not just the rows**, so a two-hop restricted result is not the
unrestricted one with rows removed — it is a different and much cheaper traversal.

**`absentMeans: true`.** A stored node written before this control queried every partner, which is
not the default, so absence is written in on load. Contrast the region params, whose absence and
default agree and which therefore carry no such key.

**No warning when the box is unticked**, deliberately. A badge on every Connectivity run is a badge
nobody reads by the third one, and the unticked box is already on the card. The asymmetry runs the other way: opting *into* fragments is what leaves the `Neuron Set`
port with empty columns, and that is warned about where it happens.

#### Both exporters had always disagreed with the canvas

Reading the libraries rather than the docs turned up a translation bug older than this change:

- neuprint-python's `@neuroncriteria_args` turns a `None` far end into `NeuronCriteria()`, whose
  `label` is `'Neuron'` when no `bodyId` is given, and `fetch_adjacencies` interpolates it into
  `MATCH (n:{sources.label})-[e:ConnectsTo]->(m:{targets.label})` (read off the installed 0.6.3).
- neuprintr's `neuprint_connection_table` builds `MATCH (a:{node})-[c:ConnectsTo]->(b:{node})` with
  `node = ifelse(all_segments, "Segment", "Neuron")` (read off natverse/neuprintr).

So the notebook and the R document have always returned the 496-partner answer for a canvas showing
4,252 — silently, in both languages. The new default is the text they already emitted; what needed
writing is the *other* setting, and `:Segment` is an exact translation of the bare match rather than
an approximation (4,252 partners and 11,898 synapses either way, because every `:Neuron` in neuPrint
is also a `:Segment`).

One difference survives and is written into the generated R rather than only here: neuprintr applies
the label to **both** ends, so with `all_segments = FALSE` a queried body that is not itself a
published neuron returns nothing, where the canvas always keeps the neurons you named.

What is *not* translated is the population narrowing on the far end — `NeuronCriteria` takes values,
so a superclass that is merely *set* is not expressible, and `fetch_adjacencies` returns only `type`
and `instance` for a partner to post-filter on. Both emitters carry a `note` naming it when the
dataset has a population. Small and said rather than large and silent: 496 against 492.

### The Neuron Set port: an edge list is the wrong type for the node that comes next

The node has a second output — the distinct neurons its result is about, as a `Neurons` table.

**The gap it closes is a type wall, not a missing query.** The obvious workflow is: start with a
set of neurons, pull their partners, then get all the connections *among that whole set* and run
network statistics over it. Step three is `Adjacency` with the same set on both inputs — and
`Adjacency` takes two `T.neurons()`, while `Connections` is a `T.table()` of `preId`/`postId`.
`isSubtype` allows `neurons → table` and deliberately not the reverse, so the wire is refused.
Assembling the set by hand meant `Rename` → `Stack` → `Dedupe` → `Input IDs`: four nodes to say
"the neurons I just found", none of which is about connectomics.

**Not called `Neurons`, though that is what it holds.** The input port is already `Neurons`, and a
node carrying one label on both sides means a *pass-through* everywhere else in the registry —
`out.profile` is literally one (`out: table`), and so is `Labels to Neurons`. The port **id**
differs for the same reason one level down: `ctx.input('neurons')` beside `ctx.output('neurons')`
in one `evaluate` is a typo with no type error behind it. It is also the only camelCase port id in
the registry, which is why `outputName` splits camelCase — and why it does so on the *port id*
rather than in `pyIdent`/`rIdent`, whose other caller is the node label and would spell the
neuPrint dataset node `neu_print` in every document ever exported.

**Two outputs describing one traversal**, which is `neuron.adjacency`'s arrangement (`Matrix` and
`Links`) and `neuron.roiConnectivity`'s before it. `Connections` stays first, so a link dragged off
the card starts there and every graph saved before this port existed keeps its wiring —
`neuron.explore` appended `all` on the same rule.

**The seeds are in the port, and that is the half a downstream transform could not have done.**
Both ends of a hop-1 edge list already cover every seed that had a partner above `Min weight`; a
seed that had none disappears from the union entirely, silently. This node is the only place
holding both the seed set (on its own input) and the result, so only here can the port mean "the
neurons this result is about" rather than "the ones that turned out to be wired". That is also the
argument against solving this with a generic `Neurons from Connections` transform: such a node is
worth having for the other edge-list producers — `Adjacency ▸ Links`, `Paths`, an uploaded edge
set — but it structurally cannot see the seeds.

**Derived by default, full rows on request.** `Neuron Set` picks between two schemas:

- `derived` reads `neuronId` and `type` straight off the `preId`/`preType` and `postId`/`postType`
  columns already in hand. No query, and enough for everything keyed by id — `Adjacency`,
  `Skeletons`, `Meshes`, `Synapses`, `ROI Counts` all reach their ids through `idColumn` and read
  nothing else off the row.
- `full` looks every neuron up with `findNeurons` for the columns an edge list has no room for.

`inferOutputs` declares whichever of the two `evaluate` will build (invariant 3), which is the same
split `neuron.inputIds` makes between its wired and unwired Dataset. The param carries **no
`absentMeans`**: a stored node written before the port existed emitted no neuron table and issued no
lookup, which is exactly what `derived` does, so absence and the default already agree.

Three things about the derivation that a reasonable implementation gets wrong:

- **The schema comes from the *connectivity* schema, not the dataset's neuron schema.** The cells
  in this table are the cells of `preId`/`postId`, so the declared dtype has to be theirs — a CAVE
  root id is `str` there and would be declared `i64` by the neuron schema, which is invariant 8
  with no symptom until an 18-digit id.
- **Cells are copied, never rebuilt.** `idText` is used for the dedupe *key* only; the value that
  goes into the column is the cell that came out. Nothing parses, rounds or re-renders an id.
- **The row that fixes a neuron's order is not the row that fixes its type.** First appearance
  decides the order and the first non-empty type wins, because a neuron can arrive as an untyped
  seed and be typed by an edge several rows later.

**No `hop` column, though it looks free.** `traverseConnectivity` records the hop an *edge* was
found at, and which of its two ends was the frontier is only knowable on the first round —
`partnerVectors.ts` writes down the same limit about `direction`. A per-neuron distance column
would be right at hop 1 and quietly wrong past it.

**Under `full` the lookup is a left join, and that is the port's whole point.** `findNeurons`
answers only about published neurons, so a lookup keyed by an endpoint list comes back *shorter*
than the list — 496 rows for 4,252 endpoints with fragments included. Returning what came back would
make this port a different length from the edge list it was derived from, which is the one property
it exists to have. So every endpoint survives in its order, an unmatched one keeps its id and the
type the edge carried, and the rest of its columns are null. Verified end to end against
`male-cns:v1.0`: 492/492 and 4,252/4,252 rows both ways.

The lookup itself goes through `datasetRequest`, not `neuronSetRequest` — these ids were already
decided, and narrowing them by the population a second time would reintroduce the very mismatch
this removes. The narrowing belongs on the *traversal*, which is where `Include fragments` puts it.

**Both exporters emit the port unconditionally**, the way `neuron.adjacency` emits both of its
outputs: an emitter cannot see which of its outputs the graph downstream reads, so a port left
unassigned is a `NameError` in somebody's notebook. Adding the port also *renamed* the emitted
variable — a single-output node takes the node's name unadorned and a multi-output one suffixes the
port — so `connectivity` became `connectivity_connections` in both goldens. That rename is
`emit.ts`'s rule working, not a regression, but it is the reason adding an output port to a shipped
node type touches the export fixtures.

### Normalizing a weight: two ends, two denominators, and both said out loud

`Normalize` appends two columns — `weightNorm`, the fraction, and `weightTotal`, the denominator
it was divided by. **The second one is the feature.** A normalised weight is only readable if you
know what it is a fraction of, and there are two controls deciding that: which end of the
connection the denominator belongs to, and which synapses it counts. Publishing the denominator
per row means the reading is checkable from the table alone.

**The two denominators differ by more than a factor of two, and it is not noise.** Measured on
male-cns:v1.0 body 10005 (AOTU019, Traced) — every number here was read off the server, and the
identities are asserted in `neuprint/live.test.ts`:

| | inputs | outputs |
| --- | --- | --- |
| `n.post` = `n.upstream` / `n.downstream` | 31,981 | 23,423 |
| Σ weight over **all** partners | 31,981 | 23,423 |
| Σ weight over `:Neuron` partners | 31,389 | **9,324** |
| `n.pre` (T-bars) | — | 2,837 |

Three things fall out of that table and each is load-bearing.

**The metadata total and the sum over every `ConnectsTo` edge are the same number**, to the unit,
in both directions. So there is no third "published versus computed" discrepancy to reconcile:
the `all` basis reads properties because that is cheaper, not because it answers differently.

**The output denominator is `downstream`, never `pre`.** `pre` counts T-bars and `downstream`
counts the synapses those T-bars drive — 2,837 against 23,423 on the same neuron. Normalising by
`pre` puts a plausible fraction eight times too large in the column with nothing failing, which
is why `synapseTotalsCypher` has a `coalesce` fallback on the incoming side (`upstream` and `post`
are measured equal everywhere) and deliberately none on the outgoing one.

**Only ~40% of this neuron's outputs reach a named neuron, against 98% of its inputs.** That
asymmetry is reconstruction rather than biology — outputs land on dendrites, which are hard to
trace — and it is why the basis has to be a control rather than a constant. `connected` is what
neuprint-python and the neuPrint website report and what anyone comparing edge weights **across**
connectomes proofread to different depths needs; `all` is what the dataset publishes for the
neuron and what makes a full partner list's fractions sum to at most 1.

Worth knowing when the numbers do not match somebody else's: **Coda's connectivity query matches a
bare node at the far end** (`connectivityCypher`, on purpose, so a sub-threshold `Segment` still
counts), so its unsplit table sums to the `all` total where the same question in neuprint-python
sums to the `connected` one.

**The totals are asked about the ids in the *result*, not the seeds.** Past one hop the neuron
whose denominator is wanted is generally not one anybody named, and at one hop `outputs` it is
every partner that came back. Hence `normalizeTargets`, and hence `fetchSynapseTotals` being the
one query here that **chunks** — a hop-1 fetch from a hundred neurons can be fifty thousand
partners, where the connectivity query only ever names the frontier. 5,000 ids per batch: measured
at 668 ms against 20,000 ids at 2.2 s, set where the curve is still flat.

**A missing or zero denominator is null, and counted.** A fragment on the far end of an edge has
no `connected` total, and a zero would divide to `Infinity`, which every chart draws as a bar off
the top of the axis. `ctx.warn` says how many rows and how many neurons. And a fraction **above 1**
is left alone: under `connected` the numerator includes connections to fragments that the
denominator does not, and clamping would hide exactly the case the basis exists for.

### Split and restrict by region, which are one operation

`ConnectsTo` carries its own `roiInfo` in neuPrint — the connection's synapses broken down by
region — so both controls are answered in the query rather than by reading synapses.
`connectivityRois` gates them, and CAVE and CATMAID decline: their region assignments live on
*synapses*, so answering means reading every synapse of every queried neuron, which is the work
their connection roll-ups exist to avoid.

**They are the same operation with the sum in a different place.** `Regions` restricts each weight
to the named regions and re-totals; `Split by region` stops before the re-total and emits the
parts. So the pipeline is: restrict → threshold → split, and `minWeight` sits in the middle
deliberately. Applying it per region instead would let a split silently prune the frontier, and
the whole claim is that **turning the split on cannot change which partners are found**.

Restricting is not the same as filtering, and the gap is a third: body 10005's connections that
*touch* `LAL(L)` carry 13,071 synapses, of which 9,344 are in it. Keeping the whole connection
would have been the other reading and would answer "which partners does this neuron talk to in
LAL" rather than "how much traffic is in LAL".

**How exact the decomposition is depends on the dataset, and was measured** over 20,000 sampled
connections each:

| dataset | synapses | in no primary region |
| --- | --- | --- |
| male-cns:v1.0 | 256,276 | 0 |
| manc:v1.2.1 | 385,947 | 7 |
| hemibrain:v1.2.1 | 274,844 | 1,104 (0.4%) |
| optic-lobe:v1.1 | 317,276 | 2,746 (0.9%) |

The primary set tiles male-CNS and MANC exactly; elsewhere a fraction of a percent of synapses sit
in no primary region and a split over that set **drops** them. neuprint-python meets the same gap
and buckets it under a synthetic `"NotPrimary"` name; nothing here invents a region, so this is a
documented loss rather than a row claiming to be somewhere it is not. `neuprint/live.test.ts` pins
both halves — exact on male-CNS, and within 3% on hemibrain, so a split that started losing a tenth
of a connectome fails rather than reads as data.

**`Primary regions only` is a vocabulary, not a post-filter.** It decides which names the picker
offers and what an empty picker means, and it deliberately does not narrow a selection somebody
already made — the column picker's rule about keeping a chosen value rather than substituting.
Turning it off is a real question ("how much of this connection is in the optic lobe") that simply
cannot also be a decomposition: regions nest, so a synapse in `LAL(L)` is counted again in `LX(L)`
and again in `CentralBrain`. Said at edit time *and* at run time, because it changes what the
numbers mean and `ctx.warn` is only seen by whoever pressed Run.

**The three new columns are the deliberate exception to "`hop` and `direction` are always
present".** Each has a control of its own, so a picker clearing when Split by region goes off is
that switch doing what it says — not the silent schema churn that rule is about. A `roi` column
of nulls on an unsplit result, or a `weightNorm` of nulls a chart plots as zeroes, is worse.

**An attached edge set removes both capabilities rather than adding one.** This inverts
`canTracePaths`, where a local edge list *unlocks* a hop CAVE cannot answer. A file of
`pre, post, weight` says nothing about regions, and its weights count a different population from
the backend's published totals — so normalising one against the other produces fractions that are
individually plausible and collectively meaningless. `canSplitConnectivityByRoi` and
`canTotalSynapses` refuse; `connectivityFor` and `synapseTotalsFor` refuse again at run time, for
the graph whose dataset gained an edge set after the node was set up.

**Exported asymmetrically, and for a checkable reason.** The notebook translates the region half
onto three arguments of the `fetch_adjacencies` call the cell was already making — it answers
per-ROI, restricts to the primary set by default and takes an explicit `rois` list, all of which
was read off the installed neuprint-python 0.6.3 by introspection. It refuses normalisation,
because `connected` has no neuprint-python equivalent and emitting only the reachable half would
put a different number in the notebook from the one on the canvas. R Markdown refuses both:
neuprintr was not installed to check its argument names against, and this codebase has been bitten
by recalling that API before (`Client.fetch_roi_hierarchy` does not exist — see `roiHierarchy.ts`).

## Paths: how does this reach that?

`neuron.paths`, added from `Add ▸ Query ▸ Paths`. `Connectivity` answers "what is wired to
this?"; this answers "how does this reach that?", which is a different query with a different
result. Three outputs: a **Network** already pruned to the feed-forward connections on a route,
the **Layout** for it, and a **Paths** table of one row per route.

**The traversal runs on the collapsed graph, not on the neuron graph it was collapsed from.**
This is the decision everything else follows from. With `Collapse types` on (the default), `LC4`
is one node, a hop expands _every_ LC4 neuron, and the result is aggregated back to types before
anything is pruned or expanded again. So `LC4 → PLP1 → DNp01` is found even when no single PLP1
neuron both receives from an LC4 and projects to a DNp01 — which is usually the circuit somebody
means, and is **not** recoverable by collapsing a neuron-level result afterwards, because the
neuron-level search would never have returned either edge.

The knock-on is that **`Min synapses` is a threshold on type-level traffic**, a much larger
number than any one connection carries, and it is applied _after_ the `sum` rather than before.
Cutting each synapse group first would discard the many weak connections that are exactly what
adds up to a strong pathway.

**So the aggregation has to happen in the backend**, which is what `DataSource.fetchPathStep`
and `PATH_STEP_SCHEMA` are for. A type-level hop on male-CNS touches every neuron of every
frontier type and collapses to a few hundred rows; doing that client-side would mean
downloading the former to compute the latter, per hop. `pathStepCypher` does it in one `WITH`.

**The frontier is two lists, not one.** A neuron with no type stands as its own node — there is
nothing to collapse it into — so a frontier is a mix of type names and neuron ids, and
`sourceId`/`targetId` are null exactly when the key names a type. Both halves of the `WHERE`
are then index-backed, where a `coalesce(n.type, toString(n.bodyId)) IN [...]` would express the
same set and force a label scan of every `:Neuron` in the dataset.

**Both ends of a path step are `:Neuron`, unlike a connectivity fetch.** `connectivityCypher`
deliberately matches the far end as a bare node so a `Segment` below the neuron threshold still
counts towards a total. A route _through_ an unnamed fragment is not a circuit anyone traced,
and the fragment would be expanded at the next hop. Reporting a total and tracing a route want
different sets.

**The search is bidirectional, and that is what makes four hops askable.** Forward `⌈h/2⌉` hops
from the sources, backward `⌊h/2⌋` from the targets. Every edge of every route within the budget
is still covered — the edge at position p is reached forwards when `p ≤ ⌈h/2⌉` and backwards
otherwise, since then `L − p ≤ ⌊h/2⌋`. Each hop multiplies the frontier by the average partner
count, so halving the depth square-roots the work.

**A route's strength is its bottleneck**, the weakest link along it, and `N strongest` keeps
whole _routes_ by that measure. Summing was considered and is wrong for the same reason it is
wrong in `BuildNetwork`: it prefers a long chain of large numbers with a 2-synapse step in the
middle to a short one where nothing is weaker than 40. A bottleneck is also comparable between
routes of different lengths, which a sum is not — and the ranking deliberately spans lengths, so
a strong 3-hop route beats a weak 2-hop one.

**neuprint-python's `fetch_shortest_paths` was considered and declined**, and it is worth
knowing why, because it is the reference implementation and it _is_ the more efficient shape
for the question it asks:

```cypher
MATCH (src:Neuron {bodyId: X}), (dest:Neuron {bodyId: Y}),
      p = allShortestPaths((src)-[:ConnectsTo*]->(dest))
WHERE ALL (x IN relationships(p) WHERE x.weight >= $min)
RETURN [n IN nodes(p) | [n.bodyId, n.type]], [x IN relationships(p) | x.weight]
```

One round trip, and — the real win — no frontier inlined into the query, which is this node's
one known weakness at neuron level. It fails on two counts here, both of them semantic rather
than technical. `allShortestPaths` returns **only** shortest routes, so it discards the strong
3-hop route the moment any weak 2-hop route exists, which is the ranking's whole point. And it
walks `:Neuron` nodes, so it cannot run the _default_ mode at all: collapse-first needs the
traversal on the type graph, and Cypher cannot walk a derived graph without GDS. Its 5s default
timeout is also an admission that the query can run long. Do not swap the per-hop loop for it
without changing both of those decisions first.

**Ranking is depth-first with branch-and-bound, not enumeration.** The number of simple routes
is exponential in the hop budget. Bottlenecks only ever fall, so once the shortlist is full any
partial route already no better than its weakest member is abandoned whole; neighbours are
visited strongest-first so the bound bites from the first branch. `toTarget`, computed during
pruning, kills anything that cannot reach a target in the hops that remain.

**`topN: 0` means "as many as are worth listing", not literally all of them,** and that was got
wrong first. Eight layers of nine nodes is five million routes, each an array. Worse, with no
shortlist there is no _bound_, so the search degenerates into the full enumeration the
branch-and-bound exists to avoid — the first version of this hung the test run rather than
returning slowly. `MAX_PATHS_KEPT` (50,000) caps it and `truncated` says so — on the card as well now, through
`ctx.warn`, since a truncated ranking is "the strongest found" wearing the label "the
strongest" and a progress note is gone by the next repaint. The shortlist is a heap
keyed by the same comparator the final sort uses, because it is consulted on every branch: a
sorted array re-sorted per insertion is what made the `topN: 0` case quadratic.

**Pruning is what makes the network feed-forward, and it is an inequality rather than a rule.**
A node survives when `fromSource + toTarget ≤ maxHops`, an edge when
`fromSource[u] + 1 + toTarget[v] ≤ maxHops`. An edge running against the flow, or between two
nodes at the same depth with no way onward, fails it. Both distances are measured on the
_collected_ graph and that is exact rather than approximate here, precisely because of the
bidirectional coverage above.

**The network spans the kept routes, not the pruned graph.** A node reachable within the budget
but not on any route that survived the ranking is not in the picture — otherwise `N strongest`
would silently mean "N routes listed, everything drawn". `paths` on each node and edge counts
how many kept routes run through it, which is the nearest thing to a betweenness available for
free and reads well as a size encoding.

**No route is an answer, not an error.** "These two are not connected within N hops at this
threshold" is a real finding; throwing would block everything downstream from ever drawing the
empty result that says so.

**Known limit, same as Connectivity's:** at neuron level the frontier is inlined into each
query, so a deep neuron-level traversal builds a very large Cypher string. `validate` warns
above three hops and warns again when `Collapse types` is off there. A warning, never a refusal
— the same call `Find Neurons` makes about `limit: 0`.

### The Layout output, and `T.layout()`

A new value kind: `{ kind: 'layout', positions: Record<id, {x, y}> }`, with a matching optional
**`Layout` input on `out.network`**. Fixed ELK layered, left to right, in `src/layout/network.ts`.

**A type rather than a table of `id`/`x`/`y`.** A layout is not data about neurons — it is an
arrangement computed _for_ a particular node set. A table would accept any two numeric columns
and fail at run time with a column picker to configure first.

**An input rather than another entry in the `Layout` enum.** Whether positions arrived is a fact
about the wiring, not a choice made in the styling panel: as a mode, the enum would silently
change under someone the moment they connected a wire, and stay changed when they pulled it.
Connected, it wins over the param, and the caption says `layout from input` — a control that
quietly stops doing anything is worse than one visibly overridden.

**It reaches `evaluate` never, and the drawing always.** `out.network` ignores the socket
entirely, so wiring one up invalidates nothing downstream. That is the same standing every
presentational param here has, arrived at by the value never reaching the output rather than by
a flag.

**Given positions are not normalised, unlike every computed layout in the viewer**, and nodes
they do not name fall through to the chosen algorithm rather than stacking on the origin — so a
layout that outlives an upstream filter degrades instead of collapsing. A layout matching
_nothing_ falls back entirely.

**`useStablePositions`, not `useStable`.** The structure effect is the most expensive dependency
list in `NetworkViewer` (`networkRebuild.test.tsx` is the guard), and `nodeInputs` mints a fresh
record on every store tick. `useStable` would `JSON.stringify` two floats per node on every
render; the fingerprint is one pass and no allocation.

**The layout is fixed rather than configurable, and that is the trade.** It is an _output value_,
so a spacing slider would take part in the provenance key and stale everything downstream when
nudged. Restyling is what the Network Viewer's presentational params are for.

**`src/layout/network.ts` is a sibling of `elkGraph.ts` and shares only the engine.** That module
maps editor cards — measured sizes, one ELK port per socket, a fixed port order so wires arrive
in the right handle. A network node is a disc drawn from its centre with no sockets at all, and
its size is whatever the encoding says at render time. So: a nominal box, node-to-node edges,
and **centres rather than ELK's top-left corners**, since sigma places a node at its centre and
corners put the whole picture half a box out. A dangling endpoint is dropped rather than
allowed to make ELK reject the entire graph.

`runElk` is exported from `engine.ts` for this. Both callers get one lazily-loaded engine, and
elkjs still never enters the main chunk — verify with `pnpm build`.

### Normalising a route

`Normalize` is `Connectivity`'s control with the same two output columns — `weightNorm` and the
`weightTotal` it was divided by — the same `Normalize by` (the target's input, or the source's
output) and the same `Denominator` (all synapses, or reconstructed partners only). Four things
about it are this node's own.

**The denominator belongs to a group, not to a neuron.** With `Collapse types` on, an edge's
weight is every LC4→PLP1 synapse summed, so the number it is divided by has to be everything every
PLP1 neuron receives. The frontier carries the type *name*; a per-neuron total cannot answer that
without first shipping every member id back out — three thousand of them on male-CNS to get one
number. So the seam has a second method, `fetchGroupTotals`, answering `GROUP_TOTALS_SCHEMA`:
`key, total`, keyed in the traversal's own vocabulary where a key is a type name or an id as text.
It is a separate method rather than a widened `fetchSynapseTotals` because that one answers in the
source's id dtype and is read through `idText`, and one key column meaning both is how the reader
that arrived second gets the wrong answer. Same capability flag, since a source that publishes
per-neuron totals can group them; a separate predicate, `canTotalGroups`, because the *method* is
separately optional and a source with the flag and without it has to refuse before the run rather
than during it.

**The denominators are fetched per hop, not once at the end.** That is what `Min fraction` buys:
a connection below it is not followed, so the groups behind it never enter the network. A
denominator that arrived after the search was over could rank what was found and could not change
what was walked. The cost is a second query per hop, asked only about keys not already seen — a
hub type is reached on most hops of most searches, and the bidirectional walk meets in the middle
by construction, so the cache is doing real work rather than tidying.

**`Rank by` exists because the two weakest links are different steps.** On the bundled optic lobe,
L1 to DNp02 in four hops: eight routes run through LPLC2 carrying 375 synapses at their narrowest
step, and one runs through LC4 carrying 352 — so in synapses LPLC2 wins by 6%. But LPLC2 takes
~15% of its input from any one T4 subtype where LC4 takes 61% from Tm3, so as a share the LC4
route wins four times over. Both numbers ride on every route whichever ranking ordered it, which
is what lets one be read against the other; the bound, the neighbour order and the shortlist all
read the metric through one function, because a search bounded by one number and ranked by another
prunes away its own answer and still returns something plausible.

**An unmeasured connection is never dropped and never scored.** `PathEdge.norm` is `null` where a
group's denominator was asked for and not published, which is the state the whole design turns on:
the floor lets it through, because a threshold that deleted what it could not measure would report
an absence as a decision, and the ranking sorts it below every route it could score with the node
saying how many groups that was. `RankedPath.bottleneckNorm` is `null` there — and equally on a run
that did not normalise at all. One state for both on purpose: nothing reads them apart, and which
question was asked is the caller's own answer, said once in `pathTableSchema` rather than sniffed
back off the data.

The Paths table carries `bottleneckNorm` and deliberately **no denominator column**, which inverts
`weightTotal`'s rule one table over: a denominator belongs to a connection, and a route's two
bottlenecks are routinely different steps, so one column could name the denominator of neither.
The Network output is where each fraction sits beside its own total.

Both exporters refuse a normalised Paths node, for `Connectivity`'s reason plus one: `fetch_paths`
and `neuprint_get_paths` have no group denominator *and* no `Min fraction`, so an export without
them would walk a different graph and return different routes — not the same routes missing two
columns.

### The card

`PathsBody` draws the settings and then a caption under them.

The caption is what the body exists for. It reads the node's own `paths` output and shows
`N routes · min H hops · W syn bottleneck` — the two numbers people actually want from a path
query are the shortest route and the strongest one's bottleneck, and neither is legible from a
network of a few dozen nodes. A body rather than an entry in `describeValue`, because the footer
summary is keyed to the _first_ output — where "24 nodes · 31 links" is the right thing to say —
and because a body can say "not run yet" in its own words. Not `expandable`: there is nothing
here that benefits from room, and the routes themselves are a table.

**The settings are on the card because a body replaces the param band outright.** None of them is
`advanced`, and they are the whole of what the query is — yet for as long as this body
drew only the caption, the only way to reach one was the inspector, which on screen is
indistinguishable from a node that has no settings. The sharpest form of it: the empty readout
says "raise `Max hops` or lower `Min synapses`", and there was nothing on the card to raise. So
the fields are rendered from the definition, non-advanced and in declaration order, exactly as
the band would have — `pathsBody.test.tsx` asks the definition rather than a written-out list,
so a setting cannot arrive drawn nowhere. The four normalisation refinements are `visibleIf`-hidden
rather than trimmed, so the card is five rows until somebody turns `Normalize` on and nine after;
that is also what keeps them out of the provenance key while they mean nothing.

Two details it shares with the other bodies. `ParamField` gets `variant="inspector"`, which
suppresses a checkbox's own label — the row already carries one, and `Collapse types` written
twice reads as two settings; the generic card solves the same collision in CSS
(`.param--wide .param__label { display: none }`), which is the wrong half to borrow where the
fields share a label column. And the card is `.list-body`, adding only a wider label column
(86px against the shared 72px) because `Collapse types` is longer than anything on the
paste-target cards.

## Influence: how much of this is attributable to that?

`neuron.influence`, added from `Add ▸ Query ▸ Influence`. `Paths` ranks whole routes; this sums
over *every* route at once, which is the question people mostly have and which no ranking of
chains answers. It is the influence score of Bates et al. (2026,
[doi:10.1038/s41586-026-10735-w](https://doi.org/10.1038/s41586-026-10735-w)), bounded to a ball
instead of solved over a connectome. The arithmetic is `nodes/lib/influenceOps.ts`, headless with
the fetch as a callback; the node is the wiring and the gates.

**A bounded walk is not a different metric.** The published score is `r = (I - gW)^-1 s`; that
inverse is the series `s + gWs + g^2 W^2 s + …`, so walking *H* hops and adding the terms computes
the same quantity truncated. Every term is non-negative, so the answer is a strict lower bound and
more hops can only raise a score. That property is what the whole design leans on: three separate
losses — the unwalked tail, the frontier limit, the drive that reached a fragment — all subtract
and none add, so each can be reported as a number rather than a caveat.

### The gain is the published `lambda_max`, and its default here deliberately is not

With input-fraction weights (`count / sum(count) per post`, the reference implementation's `norm`)
W is row-stochastic, so `lambda_max(W)` is 1 and the package's rescale by `lambda_max /
lambda_max(W)` **is** a per-hop factor of `lambda_max`. Measured rather than argued: on
`InfluenceCalculator`'s own C. elegans matrix, `lambda_max(W) = 1.0000000000`. So `Gain` is the
same knob and not an analogue of one.

Which is what makes the default a decision. A budget of *H* hops covers `1 - g^(H+1)` of the
series, and the package's own docstring says 0.99 amplifies the leading eigenmode a hundredfold —
an eigenmode belonging to the whole connectome rather than to anybody's seed, i.e. exactly the
part a ball can neither see nor should want to. `pnpm probe:influence` measures the consequence
against the exact solve on 300 neurons:

| gain | hops | mass kept | top-20 agree | rank corr |
| ---- | ---- | --------- | ------------ | --------- |
| 0.5  | 4    | 97.0%     | 19/20        | 0.9980    |
| 0.75 | 4    | 76.8%     | 18/20        | 0.9855    |
| 0.9  | 4    | 42.2%     | 13/20        | 0.9433    |
| 0.99 | 4    | 6.5%      | 6/20         | 0.8605    |

Hence 0.5 and four hops. The probe asserts both ends of that — the defaults recovering the score
*and* the 0.99 counterpart failing to — so moving a default fails the probe rather than passing
quietly. **The package's own default (`syn_weight_measure='count'`) is not implementable here at
all**: its scale factor is a spectral property of the whole matrix, which is precisely what a ball
cannot know.

### The two directions are not symmetric, and the cheap one is the one people ask for

Travelling `inputs` — "which neurons influence this set" — fetches each carrying neuron's **input
list**, which is simultaneously the edges *and* their denominator. And because a post's input
fractions sum to one, mass is conserved per hop: the propagating vector is a distribution over
where the drive came from, so a discarded fraction is literally a discarded fraction of the
answer. One query per hop, every backend.

Travelling `outputs` fetches an output list, whose denominators belong to the *far* end — a second
lookup, gated on `synapseTotals` — and nothing bounds the total mass. `propagate` throws rather
than falling back to an out-normalisation, which would be a different quantity under the same
column name.

The demand is for the first one, which is the cheap one. That is luck, but it is load-bearing luck.

### This is not a breadth-first search

`W^k s` requires **every** neuron holding mass at hop *k* to spread it, whether or not it also
spread at hop *k-1* — that is what puts recurrent loops into the score at all. So a neuron is
*fetched* once and cached, then propagated from on every later hop.
`traverseConnectivity` does the opposite and skips an expanded node; doing that here returns
plausible scores with every recurrent contribution missing. `influenceOps.test.ts` pins it on a
two-cycle.

### `Denominator` gates the modes rather than being swapped underneath anybody

Two real definitions of W, differing by the input mass below `Min synapses`. A node that picked
one per backend would compute two different matrices under one column name — the substitution
`Connectivity`'s `Normalize` already refuses one layer down. So it is a control, and it decides
what the node can do:

- *summed within the traversal* — free, every backend, bit-for-bit the reference implementation
  (which computes `norm` after its `count_thresh`). Computable only from the postsynaptic end, so
  **upstream single-pass only**.
- *published totals* (`connected` or `all`) — one query per hop, `synapseTotals` only, and both
  `Downstream` and the meet-in-the-middle become available.

**The default is `traversal`**, because `synapseTotals` is true on neuPrint and the mock and false
on CAVE, CATMAID and precomputed: defaulting the other way would put a validate issue on the node
the moment a CAVE user created it. The price is that the two things it cannot do have to say so,
which `validate` does at edit time, each naming the fix.

One interaction worth keeping: a fragment dropped by `Include fragments` still counts in the
denominator. Its share of the drive is **lost**, not redistributed — reassigning it would invent
input nobody reconstructed. That is a deliberate departure from the reference implementation,
whose denominator is the sum over whatever edge list it was handed.

### What meeting in the middle buys, and what it does not

**Not what the equivalent in `pathOps.ts` buys, and the difference is worth knowing before
changing it.** A route has to be searched from both ends because it is only a route once both
endpoints are pinned. Influence is not like that: the per-source ranking is `sum_k g^k z_k[j]`
where `z` is the backward walk, so with only the readout set named there is nothing for a second
walk to halve. A one-ended run therefore gets `{ forward: 0, backward: hops }` and no split at all.

What the split buys when both ends *are* named is **fetch count**, which is the real cost: a ball
grows multiplicatively, so `ball(A) + ball(B)` is far smaller than `ball(A + B)`. The price is that
the answer is restricted to the named candidates, since the forward half must keep them in separate
channels to say anything per source. The deeper half goes to the smaller set.

`combineHalves` takes `(channelled, pooled, scored)` and **not** `(forward, backward)`, which is a
correctness matter rather than taste: the scored set is presynaptic travelling upstream and
postsynaptic travelling downstream, so a signature naming the directions is right for one and
silently returns the seed set's scores for the other. Both orientations are tested.

The identity `z' W^k s = z_b' W^a s` holds for one decomposition per *k*, and `a = min(k, A)` is
what keeps it legal. It is checked three ways: against a fixture, against the mock source end to
end, and in the probe over a real connectome (worst relative difference 3.25e-16).

**No truncation bound is reported under a split.** Each half's bound covers its own series, and the
combined tail is neither of them — a precise-looking number bounding the wrong quantity is worse
than no number. The `hops` column is empty there for the same reason: two distances, neither of
them *the* distance.

### The seeds are deduplicated at the node, because the channels are positional

`propagate` gives each seed a channel of its own under `perSeedChannels` and sizes that array from
`[...new Set(opts.seeds)]`. Two readers then index those channels **by position** —
`influencePairs`' `queries` and `combineHalves`' `scored` — so the node has to hand them a list
whose order matches, and it used to hand them `idColumn`'s raw column.

A `Neurons` table is free to repeat an id: `Stack Tables` over two overlapping searches keeps both
the kind and the duplicates, and both import nodes carry whatever is in the file. Past the first
repeat every channel shifted by one, and the failure was silent in three directions at once — one
neuron's influencers came back filed under another's name, the last query vanished from the table,
and a surplus candidate read off the end of a `Float64Array`, scored `NaN`, and was dropped by the
`score > floor` filter that follows.

Worth knowing for anyone writing a test against it: the overlap has to be **interleaved** to show
anything. A set stacked onto *itself* gives `[a, b, a, b]`, whose first two entries are already the
unique ones in order, so every channel still lands correctly and the bug hides. Two overlapping
searches give `[a, b, a, b, c, d]` against a unique `[a, b, c, d]`, which is the fixture
`influence.test.ts` builds.

The fix is one dedupe at the point a table becomes a list rather than a guard in each reader, and
it fixes `seedMass` on the way: `1 / seeds.length` over the raw column started a `share` run with
less than one whole unit of drive in it. `combineHalves` now also throws when the two lists differ
in length, because that is the only way a second route to the same mistake can announce itself.

### One port whose shape follows its control

`Per query neuron` turns one row per influencer into one row per (query neuron, influencer),
which is what a `Pivot` needs to build a queries x influencers matrix for a Heatmap. It is the
same port, not a second one — `Connectivity`'s `Split by region` arrangement — because the totals
are a `Group By` away from the pairs and a port that is empty on most runs is worse than a shape
that follows what the card says.

**The `kind` changes with it.** Off it is a `Neurons` value; on, `neuronId` repeats once per query
neuron, which is not a neuron set however much it looks like one, so `inferOutputs` declares a
plain table and a wire into a Neurons-only input goes red. Louder than a picker clearing, and
correct: the alternative is Skeletons silently fetching one body a hundred times.

The mechanism is `propagate`'s `perSeedChannels`, already built for the forward half of a
meet-in-the-middle — this points it at the other end. Which is also why the two cannot both run:
the channels index one set, and asking for both would be an outer product per reached neuron
rather than a vector. With both asked for, the node walks the full depth and filters, and says so
at edit time.

Two properties are pinned rather than assumed, because a channel written at one index and read at
another still produces a full and plausible heatmap: the pairs summed over `queryId` equal the
plain ranking exactly (asserted through the mock source, and again in the probe against the
generated helper), and the guard is made against the *measured* reached set rather than an
estimate — `Frontier limit` bounds what carries onwards per hop, not what has accumulated, so the
product of the query set and the ball is only knowable after the walk.

### Neuron level, always

Unlike `Paths`, this never collapses to cell types. The model is linear over neurons, and influence
is linear, so a per-type total is a downstream `Aggregate` on the result — exactly right, where a
type-level *walk* would be a different quantity.

### The exporters

The Python emitter is one generated helper, `coda_influence`: `fetch_adjacencies` per hop with the
propagation over it. `ConnectomeInfluenceCalculator` is deliberately **not** the route — it solves
seed-to-all over a whole edge list and needs petsc4py and slepc4py, so it is both a fourth
dependency and the problem the node exists to avoid.

It is checked by **running it**. `probe-influence.py` execs the helper out of the golden notebook
against a stubbed neuprint over the same C. elegans graph and compares with the canvas: 277
neurons, worst relative difference 3.8e-16, under both denominators. The one thing the cell does
not reproduce is *how* a `Candidates` run got there — it walks the full depth and filters, which is
the same number by the identity above, written into the cell as a `NOTE`.

R is refused, and the reason is the export doctrine's rather than a gap in the language: neuprintr
is not installed here, so its argument names would be recalled rather than read (the
`fetch_roi_hierarchy` incident), and the R twin would have no counterpart to the probe that makes
the Python helper trustworthy. A hundred lines of unrun matrix algebra failing at the reader's
console is worse than a cell saying what to write.

## Find Neurons: a filter builder, not a form

`neuron.findNeurons`, the workhorse entry query. It used to be five fixed boxes — `Type`,
`Instance`, `Status`, `Min size`, `In ROI` — and those were **neuPrint's fields spelled as a
card**, because neuPrint was the first backend. It is a list of filter rows now:
`{field, operator, value}`, combined with AND, with the field list taken from the dataset's own
discovered neuron schema.

### What the old shape cost, measured in wrong answers

Three of the four backends paid for it, and every one of the failures returned a **count** rather
than an error — which is the worst kind, because a number looks like an answer.

- **CAVE, `Min size`.** A plain number on the card whatever was wired to it. `CaveSource` read
  `index.data.size` — a column no CAVE index has — through `Number(undefined ?? 0)`, so any
  non-zero floor compared 0 against it and dropped **every** row. A node reporting "0 neurons"
  for a datastack full of them.
- **CATMAID, `In ROI`.** `volumeList` fills `DatasetInfo.rois` with eighty real neuropils so the
  ROI Viewer can draw them, and the picker read that list. `findNeurons` never read `req.roi` at
  all: a populated dropdown that narrowed nothing, whose result was too *large*.
- **CAVE, `Status`.** The worst of the three, because nobody chose it. The default was `Traced`,
  it survived into the request whatever the picker offered, and a datastack that publishes no
  status matched no row. The exported CAVE notebook carried a cell reproducing it and a NOTE
  explaining the fix — see [export.md](export.md).

`refuseUnfilterable` was written to catch the first two. It could not catch the third, for the
reason its own comment gave: refusing there would fail a value nobody had chosen.

### Rows make two of those unreachable rather than caught

A row names a field of the dataset's **own** neuron schema, which Coda already discovers per
dataset — so hemibrain offers `cellBodyFiber`, manc `hemilineage`, a FlyWire datastack
`super_class` and `cell_sub_class`, CATMAID `annotations` and `cableLength`. `size` on CAVE is not
a filter that gets refused; it is a field that was never in the dropdown. Same for `status` on
CATMAID. What is left to refuse is a graph saved against one backend and repointed at another,
which `validate` reports **on the card before anything runs** — possible here and not in
`out.table` because a Dataset socket carries its schema at edit time.

Which way that errs is the decision. `tableFilter.ts` *drops* a clause it cannot apply and shows
more rows, which is right for a tap. Dropping one here sends a broader query to a shared
production Neo4j and returns neurons nobody asked for — so a row is reported, never dropped.

### Rows are ANDed, and there is no bracketing

The same call `neuronSearch.ts` made for the search box: "every extra operator is something a
newcomer can get wrong, and the graph already has a Filter node for anything this cannot express."
Two further reasons apply here and not there. **`NeuronCriteria` has no disjunction at all**, so
one OR group would force every exported neuPrint notebook to abandon it for a local pandas
filter — and it is precisely because rows are independent that the exporter can push some down and
mask the rest. And the thing people reach for OR to say is a *set*, which `is one of` says
directly and faster: it compiles to an indexed `IN` list where an alternation forces a scan.

### `In ROI` is the one control that is not a row

A region is not a column. In neuPrint a neuron carries one boolean property per ROI it
innervates, so the test is `n.\`LO(R)\` IS NOT NULL` and the name appears in no schema — a
schema-driven dropdown cannot offer it. So it stays a named axis, gated on the new
`capabilities.roiFilter`: whether the source can **answer** a region filter, not whether it
publishes a region list. Those two came apart on CATMAID, which is the whole reason the flag
exists rather than a `rois.length > 0` check.

### One term model, three surfaces

A row is not executable. It lowers two ways and the pair is the design: `toTerm` to a `FieldTerm`
for a source filtering an index it already holds (CAVE, CATMAID, the mock), and `findNeuronsCypher`
to a `WHERE` clause for neuPrint. `FieldTerm` and its matcher moved down to `data/terms.ts` so
that both layers can call the same code — `src/nodes` imports `src/data` and never the reverse —
and it is the same model Explore's search box and the Table viewer's header cells run on.

The friendly operators lower into the **existing** `CompareOp` vocabulary rather than widening it:
`contains` is an unanchored escaped regex, `matches` an anchored one, `is one of` an anchored
alternation, `is empty` a negated `.`. So `tableFilter.ts` and both export compilers needed no new
cases and cannot fall behind a row shape they have never heard of.

**The one thing that had to be added is `ignoreCase`, and it is written out at every construction
site rather than defaulted.** The two surfaces genuinely disagree: a search box is
case-insensitive, and Find Neurons is not, because its rows are also compiled to Neo4j's `=~`
and `=`, which are case-sensitive. That divergence was not new — Explore's `~` had always been
insensitive where `findNeuronsCypher`'s `=~` was not — it was simply unrepresentable, and so lived
as an undocumented difference between two files.

### The sharpest edge: negation and nulls across the seam

Coda's rule is that a **missing value satisfies a negated comparison**: `status is not Traced`
returns the untraced *and* the unlabelled, which is what somebody auditing a dataset for gaps
means. Cypher does not do that. `NOT (n.status = 'Traced')` over a null `status` evaluates to
null, and `WHERE` keeps only *true*, so the unlabelled vanish with no error and no count to
compare against. Every negated row therefore compiles to `(NOT (…) OR n.prop IS NULL)`. Get it
wrong and one graph returns different neurons on CAVE and on neuPrint, silently.

### A new node filters nothing, and the old params still work

No rows, no status, no limit — an honest "everything in this dataset", uniform across backends.
The old `Traced` default was a filter nobody chose. Note the cost of the other direction, which is
real: a fresh node on hemibrain now asks for all 176,422 neurons including untraced fragments.

**The five old params are still declared and still read**, folded into rows by
`nodes/lib/findNeuronsRows.ts`. A load-time migration was considered and rejected: `addNode` and
`defaultParams` never go through `deserializeGraph`, so it would have caught saved files and
missed the six starter graphs, the export golden, and some fifty tests that build the node by
writing `{ typePattern: 'LC.*' }` directly.

They are `advanced`, **not** `visibleIf`-hidden, and that is invariant 4 rather than taste:
`normalizeParams` drops a hidden param from the provenance key, so one that still reached
`evaluate` would let a stale result survive an edit to it. Saved graphs are unaffected by the
changed `status` default because `defaultParams` wrote the old value into every node when it was
created. The card shows legacy params as ordinary rows and converts them in the edit that touches
them — a conversion somebody performed, rather than one that happened to their file on load.

## IDs from Label: the inverse query

`neuron.idsFromLabel`, added from `Add ▸ Query ▸ IDs from Label`. Every other query node
narrows a population; this resolves a **named set** — labels in, the neurons carrying them out.

**It is not `Find Neurons` with a different label, and the overlap is worth knowing so nobody
"simplifies" one into the other.** A `type is one of LC4, LC6` row in Find Neurons returns exactly
those two types, and does it through the same indexed `IN` list. That case is genuinely covered.
What is not is where the labels actually come from: the `preType` column of a Connectivity result,
a `groupBy` roll-up, a list pasted out of a paper. None of those can be typed into a regex field,
and the node that turned a column into an alternation would be this node with an extra step.

**Labels arrive from two places and they union.** A `Labels` text param and an optional `Labels`
table input with a column picker. Not one overriding the other: both are things somebody asked
for, and a node that silently dropped the text field the moment a wire arrived would look correct
— the result is a valid neuron table either way. `collectLabels` in `nodes/lib/labelLookup.ts`
owns the union, deduplicating with first-occurrence order kept, because that order is what the
unmatched report is printed in.

**`LabelMatch` is a member of `FindNeuronsRequest`, not a third pattern field.** The seam had
`typePattern` and `instancePattern`, hardcoded to the only two fields anyone had needed; a lookup
on `class` or `hemilineage` would have been that same edit twice more. So the request names the
**property**, which is what lets the field picker read the dataset's _discovered_ neuron schema.
That reasoning is the seed of the filter rows above — applied once more, to its conclusion — and
`LabelMatch` survives beside them because this node resolves a named set rather than narrowing a
population, which is a different question with a different empty state.
The literal form compiles to `n.\`type\` IN […]`, which neuPrint has indexed — the equivalent
regex alternation expresses the same set and forces a scan of every `:Neuron` in the dataset.

**Empty `values` matches nothing, which inverts the field beside it.** An empty `typePattern`
means "do not narrow", i.e. everything. A lookup of nothing is nothing. A source implementing
`LabelMatch` must not read an empty list as "no filter" — an unconfigured node firing an
unbounded `MATCH (n:Neuron)` at a shared production Neo4j is a hazard, not a default. The node
answers that case without a query at all, returning an empty table _of the right schema_ so
downstream column pickers populate before anyone has typed anything.

**Literal is the default; regex is opt-in.** A label is text somebody copied out of a result, and
`SMP001(a)` and `5-HT` carry regex metacharacters — reading those as syntax turns a lookup into a
different question with no error to say so. Under `regex`, each value is matched with the same
anchored whole-string semantics `typePattern` has, and `MockSource` wraps in `^(?:…)$` exactly as
`compileRegex` does, so the two sides of the seam agree.

**Each regex is matched on its own — `any(p IN […] WHERE n.f =~ p)`, never one alternation.**
`=~` anchors the _whole_ pattern, so folding `LPLC1|LPLC2` into a surrounding `^(?:…)$` splices
its alternation into the outer one and quietly matches a superset of what that entry means alone.
Per-pattern matching gives each entry exactly the semantics it would have in Find Neurons' Type
field, which is the only comparison a user can make.

**Null handling falls out rather than being coded.** A neuron with no value yields `null IN […]`
or `null =~ p`, both null, and Cypher's `WHERE` keeps only true; `toLower(null)` is null too, so
the case-insensitive form needs no guard. The mock reproduces it explicitly — a missing
`hemilineage` is not a match for the empty string.

**There is no `limit`, and its absence is load-bearing.** Every other query node has one. Here it
would make the card lie: the readout reports which labels matched nothing by reading the _result_
back, so a truncated result would name labels as missing that are in the dataset. A lookup of a
named set has a size the question already fixes.

**Status defaults to `Traced`**, as Find Neurons always has, so the same label does not return two
different counts in two nodes. Advanced, so changing it is a deliberate act.

### Reporting what matched nothing

A card readout (`ui/nodes/IdsFromLabelBody.tsx`), derived from the run — **not** a warning
reported by it.

**There is no run-time warning channel, and this deliberately did not add one.** `validate` runs
at edit time with types and no values, so it cannot know what matched. A `ctx.warn` would have to
be carried on `NodeRunInfo` _and_ on the `CacheEntry`, or it vanishes the moment a result is
restored rather than recomputed — a warning that disappears while its result stays is worse than
none. The miss is derivable from what the node already publishes, so it is derived: correct after
a reload, correct from cache, and with nothing new to keep in step. Same reasoning and same idiom
as `PathsBody`. If a second node ever needs this, the channel is the right answer then; one node
is not enough to justify it.

**`unmatchedLabels` refuses in two cases, and the refusals matter more than the arithmetic.** No
result table means the node has not run, so there is nothing to be missing from. A field the
result does not carry means silence — "nothing matched" over a table full of matches is a
specific and wrong claim, where saying nothing is merely unhelpful. (Every source returns the
property it was asked to match on, so the second should not arise.)

**The positive half is shown too**, `1,204 neurons · 18/20 labels`. A line that appears only when
something is wrong is a line nobody learns to look at.

**A custom body replaces the generic param rows outright**, so this one renders the same
non-advanced set the card would have, in declaration order, rather than a chosen few — a control
a body forgets is reachable only from the inspector, which on screen is indistinguishable from a
control that was never added. `idsFromLabelBody.test.tsx` asserts the list.

## Input IDs: the ids themselves

`neuron.inputIds`, `Add ▸ Query ▸ Input IDs`. Somebody has neuron ids from a paper, a spreadsheet
or a colleague. `IDs from Label` resolves a _named_ set; this takes the ids.

**The Dataset input is optional, and that is the whole design.** Unwired, the node emits the ids
as a one-column `Neurons` table and touches no network — already enough for most of what a list
of ids is _for_, since `Connectivity`, `Skeletons`, `Meshes`, `Synapses` and `ROI Counts` all
reach their ids through `idColumn(table, 'neuronId')` and read nothing else off the row. Wired, it
fetches the full neuron rows, which buys the columns every downstream picker wants and — the part
worth having — the ability to say **which ids the dataset has never heard of**, which is how a
mistyped id is caught and is otherwise uncatchable.

**`expensive` either way, because `cost` is a static property of the definition.** A node that
_can_ issue a query must not be `cheap`: the ids are a text field, and `cheap` would fire a query
per keystroke at a shared production Neo4j (invariant 6). So the unwired case pays a Run press it
does not strictly need. That is the right direction to err and cheaper than the only alternative,
which is two nodes doing one thing.

**No status filter, unlike every other query node here.** `Find Neurons` and `IDs from Label`
both default to `Traced` so one label does not return two different counts in two nodes. Here
that would be a quiet lie: an explicit list of ids is an explicit set, and dropping one for its
status would remove a neuron somebody named _and then report it as missing from the dataset_.
Filtering belongs downstream where it is visible.

**The advertised schema changes with the wiring**, one column without a Dataset and the dataset's
whole neuron schema with one. That is the visible cost of an optional input and it is the honest
shape — advertising a `type` column that nothing will ever fill breaks every picker downstream
that believed it. Both branches are exactly what `evaluate` returns.

**`tableFromRows` defaults to `kind: 'table'`, and this node's port says `neurons`.** Passing the
kind explicitly is not decoration: a value whose kind disagrees with its port's declared type is
a disagreement nothing type-checks, and `selectTable` — the one op in the tree that branches on
`table.kind` — would take the wrong branch on a table this node had called neurons.

### Parsing, and what it refuses

`nodes/lib/idList.ts`, the sibling of `labelLookup.ts` and mostly refusals, which is exactly the
difference between the two: a label is free text and anything is a valid one, where an id is a
number and a token that is not one is a mistake somebody just made.

**Separators are whitespace, comma, semicolon — plus brackets and quotes.** The list very often
arrives as `[123, 456]` or `"123","456"`, copied out of a Python session or a JSON blob, and
refusing that paste on a punctuation mark refuses the gesture rather than the content. They are
separators and not _stripped_ characters, which is what keeps `12a` one bad token rather than a
`12` with something quietly discarded after it.

**A bad token refuses the whole list.** Skipping was considered and declined: a list of ids is a
list of neurons somebody means to look at, and dropping one quietly answers a different question.
The cost is real and accepted — pasting a spreadsheet column brings its header — so the message
says _"If you pasted a column, delete its header line"_ when the first token is a word, and only
then. A hint offered where it cannot be true is noise on top of an error.

**A wide id is now kept exactly, and the ceiling describes the data rather than JavaScript.**
This file used to refuse anything past `Number.MAX_SAFE_INTEGER`, on the grounds that `CellValue`
is a JS number so an `i64` column is really a float64 — `720575940379279312` stored as a
_different_ integer, identifying a different neuron with nothing anywhere to say so. That was
right for exactly as long as an id had to become a number on its way to a query, and the day it
predicted has arrived: see invariant 8 above. Ids are now carried as decimal digits,
so there is nothing to lose, and the refusal is a nineteen-digit width — a signed 64-bit maximum,
which is what both Neo4j and CAVE actually store.

Note what did _not_ move. With **no Dataset wired** the ids are the node's own output, and that
table's `neuronId` is an `i64` column, so the width still bites there — `validate` warns and names
the id rather than rounding it, and says to wire the Dataset that was almost certainly meant.

**The wired column drops what it cannot use instead of refusing**, and the asymmetry is
deliberate. Typed text is _authored_ — a bad token is a mistake somebody just made and can fix, so
refusing helps. A wired column is _data_, and a node that refused to run because one upstream row
had a null id would be unusable, which is why `idColumn()` has always skipped them. The card
counts what was skipped so the number is visible rather than the rows merely being absent.

**Ids are deduplicated, first-occurrence order kept.** A neuron listed twice is one neuron, and a
repeated row is double-counted by everything downstream that sums a weight. The order is what the
unmatched report prints in, so a report and the list that produced it read against each other.

**The parse is a pure function returning a message rather than throwing**, which is what lets
`validate` run it at edit time — so a refused list is reported while it is being typed — and lets
`evaluate` raise the _same sentence_. A badge and an error describing one problem differently is
how somebody concludes there are two.

### `FindNeuronsRequest.neuronIds`

A new field at the source seam rather than a `LabelMatch` on `neuronId`, and the reason is not
stylistic: `labelClause` compiles to a list of **string** literals, and `123 IN ['123']` is false
in Cypher — an empty result, with no error anywhere to explain it. `neuronIds` goes through
`idList`, which emits the digits as an unquoted integer literal.

**Present-and-empty means no neurons, never "no filter".** Deliberately unlike the label clause
beside it, which drops itself when empty and so reads an empty set as no filter at all; that is
safe there only because the node guards it. Relying on a future caller's guard for a clause that
would otherwise return the entire dataset is not a trade worth repeating, so this one compiles to
`n.bodyId IN []`. `MockSource` reproduces the same rule, or a node would pass its tests against
the mock and return the whole dataset against the real source.

### The readout

`InputIdsBody` shares a stylesheet block with `IdsFromLabelBody` — `.list-body`, renamed from
`.labels-body` when the second one arrived. The two cards are the same object: a paste target,
the node's other fields, and a line underneath saying what the run did and did not find. Two
copies is how the pair drifts on what that line looks like.

Derived from the run rather than reported by it, same as its sibling and for the same reason:
there is no channel from `evaluate` to a node's badge that survives a result being restored from
cache rather than recomputed, so a warning raised at run time would vanish while its result stayed
on screen.

**The miss is only reported with a Dataset wired.** Unwired the node hands back exactly the ids it
was given, so every id matches by construction and a `0 not found` line would be a fact about
nothing.


## List CAVE tables and CAVE table info

`cave.tables` and `cave.tableInfo`, both under `Add ▸ Dataset`. They answer the question a CAVE
datastack does not answer about itself — *what is in here* — and the reason that question needs a
node is written up in [backends.md](backends.md#a-datastack-does-not-describe-itself). Before
them, the only way to learn that `hierarchical_neuron_annotations` was FlyWire's cell typing was
to already know: `CAVE table` has a text field with `nuclei_v1` as its placeholder, and anything
else got a 404 at Run.

The fetching is `data/cave/tables.ts` and is documented there and in
[backends.md](backends.md#discovery-what-is-in-a-datastack). What follows is what the *nodes*
decided.

### Two nodes, not one, and where the datastack comes from

Both arguments are stated where they are enforced rather than restated here — the module header of
[`src/nodes/dataset/caveTables.ts`](../src/nodes/dataset/caveTables.ts) for the split, and
[`src/nodes/lib/caveParams.ts`](../src/nodes/lib/caveParams.ts) for the reference port, the
wire-beats-field rule and the three refusals it shares with `CAVE table`. Restating them cost a
contradiction the day it was written: this file said a listing was "one or two requests" while the
module said "one".

### `kind` does not move with the Include views toggle

`List CAVE tables` publishes `table` and `kind`, and `kind` is there whether or not views are
included — reading `table` on every row when they are not. That is the whole argument for having
it: a schema that gained and lost a column when a checkbox moved would take every column picker
and every Filter downstream with it. A column saying something dull beats a column that was not
there.

**Views default on**, and the reason is FlyWire: `valid_connection_v2` is the pre-aggregated edge
list the entire CAVE connectivity path is built around, and it appears in no table listing at all.
A node faithful to `caveclient.get_tables` alone would omit the most useful object in the
datastack. Turning the toggle off is exactly `get_tables`, which is why it exists.

**Sorted, tables before views.** Not cosmetic: a node's result is cached by provenance
(invariant 4), so `evaluate` has to be deterministic for fixed params — and CAVE returns the
tables in query-planner order and the views as a JSON object, neither of which is a promise.

### The info goes on the card, the columns go on the wire

`CAVE table info` has one output socket carrying one row per column — name, dtype, and an example
value from the sampled row — and puts everything else on a custom body. Everything else is
*scalar*: a schema type, two row counts, a description. A property/value table would be a table
whose rows have nothing to do with each other, and the one thing worth reading at length is prose,
which does not survive being a cell.

The card fills from `peekTableFacts` without a Run, the way the Description card fills from
`peekDataset` — and it is `expandable` for the same reason and the same source of prose: FlyWire's
`nuclei_v1` publishes six paragraphs of provenance and a request for acknowledgement.

**The card shows two row counts and labels which is which.** They disagree by up to a third and
each answers a different question; [backends.md](backends.md#the-500000-row-cap-and-why-counting-is-the-only-tell)
has the measured table and the round trip that showing one of them cost.

**The `type` column is a Coda `DType`** — `i64`, `f64`, `str`, `bool` — because those four are
already what the Upload card's column listing and the Table viewer's summary show. It is **blank**
where the one sampled row was null, which is a real hole (`superceded_id` on `nuclei_v1` is
exactly it) left as an admission rather than papered over with a guessed `str`.

And `pt_root_id` reports `str`, which is invariant 8 surfacing rather than a bug: an
eighteen-digit root id *is* text by the time anything in Coda can see it, and a listing claiming
`i64` would advertise a type no consumer will get. The notebook exporter's counterpart reports the
**pandas** dtype (`Int64` there) for the same reason from the other side — both are true of their
own runtime, and a notebook claiming Coda's answer would describe a frame the reader does not have.
