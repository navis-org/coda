# Node semantics — tables and matrices

Table and matrix nodes: reshaping, aggregating, joining, editing, and the two viewers whose
controls are part of the node rather than the drawing. One section per node whose behaviour cost a
decision. See also [adding-a-node.md](adding-a-node.md) and [nodes.md](nodes.md) for the index.

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

## Reduce Matrix: the way out of a matrix

`core.reduceMatrix` takes a `MatrixValue` to a table with one row per matrix line, carrying
whichever of `n`, `sum`, `mean`, `sd`, `min`, `max` and `median` are ticked. It is Pivot's
counterpart at the other end of the same journey, and it exists because a matrix was a dead end
for everything that is not a picture: `Normalize` and `Embed` take one and hand one back,
`Linkage` takes one and reads it as *distances*, and every node that works with numbers per
neuron — Filter, Sort, Join, Build Network, every colour encoding — takes a table.

The question that forced it is ZapBench's. A trace matrix is 3,000 neurons against 7,879
timesteps; what somebody wants from it is one number per neuron to colour a 3D scene by, and
before this node the only thing downstream of it was the Heatmap. `Neurons to ZapBench Traces → Reduce
Matrix → Join → Skeletons` is that chain. Nothing in the node knows what a trace is: a
Similarity, Adjacency, NBLAST or Pivot matrix reduces identically, which is what `Exclude
diagonal` is for.

**The axis control names what comes out, not what is consumed**, and both readings are in the
option labels for that reason. `axis: 'rows'` reduces *each row across its columns* and yields
one output row per matrix row — `matrixShape.ts`' convention, where `axisTotals(m, 'rows')` is
already a per-row vector, and the two files share `MatrixAxis` so they cannot drift. The user's
phrasing for the same operation is the opposite one ("reduce over the columns"), naming the axis
that disappears; both are reasonable and the wrong one is a silently *transposed* answer, which
is why the options read "each row, across its columns" rather than picking a side. The two arms
are one index walk — a row is `cols` cells one apart, a column is `rows` cells `cols` apart — so
nothing below the stride mentions an axis, and the test asserts each answer is the other's
transpose rather than checking numbers twice. A wrong stride still returns plausible numbers.

**Absence is `Group By`'s rule, not a new one.** Non-finite cells are skipped, which is
`axisTotals`' behaviour and what the ZapBench node's `unmatched: null` setting needs — a neuron
with no `zapbenchId` arrives as a row of `NaN`, and what should come out is *no measurement*
rather than a zero among real ones. So a line with no finite cell answers null for `mean`, `sd`,
`min`, `max` and `median`, and **0** for `sum`, which is the identity of addition rather than a
value; `sd` is null below *two* finite cells, `profileStats`' rule, since one value has no
spread where 0 claims it was measured to have none. The one place pandas differs is infinities
— `skipna` skips `NaN` and keeps `±inf` — so both emitters replace them before reducing.

**The spread is Welford's, and the closed form is the reason.** `Σx² − (Σx)²/n` subtracts two
numbers that agree to fifteen digits. Measured on `[b+1, b+2, b+3]`, whose sd is 1 at every `b`:
it is right to 1e7, answers **0** at 1e8 and 1e9, and at 1e10 answers a negative variance and so
`NaN` under the root. Both wrong answers are worse than noise — 0 is a claim that the line is
constant — and 1e8 is not an exotic magnitude for a raw coordinate or a voxel count.

**`Exclude diagonal` needs labels that line up, which departs from `skip_self`.** It drops cell
`(i, i)`, but only where the matrix is square *and* its two label lists are equal, and otherwise
is ignored with a warning. `neuron.nblastMatches` made the opposite call deliberately — its
`skip_self` "is the diagonal rather than a name comparison", holding parity with navis on a
matrix that arrives from NBLAST one node up. Here any matrix arrives: a 400-neuron trace matrix
over a 400-timestep condition window is square, and its diagonal is 400 real measurements a
positional rule would delete from every statistic on the card. Requiring the labels to agree
costs nothing where the control is meant, a similarity or adjacency matrix over one neuron set
having identical label lists by construction. The predicate is `linkageOps.ts`' — `Linkage` and
`core.embed` already ask those same two questions of those same matrices, as a refusal rather
than as a boolean, and its header records that the pair was extracted the first time the second
node restated them. `visibleIf` cannot help here — it takes params, and a matrix's shape is not
one — so the control is offered on every matrix and the run is the only place that can tell;
`filterNetwork.ts` records the same arrangement for the same reason.

**The key column is `LABEL_COLUMN_NAME`**, which is what `core.embed` and `Cut Tree` key on, so
`Reduce Matrix ⋈ Cut Tree` needs no configuration and a Join onto a neuron table needs its
`Match on` picker and nothing else. That used to be three declarations of one wire name — a
constant in `embedOps.ts` whose comment already said "so the two tables join", a literal in
`clusterSchema`, and a third here — so it is now one in `tableOps.ts`, on `ID_COLUMN_NAME`'s
rule: a constant earns its place by linking the sites where a mismatch fails **silently**, and
a table that spelled this differently would still join, only after somebody set two pickers.
Deliberately not `neuronId`: a matrix's row labels are whatever the node above put there, which
after a Heatmap relabel or a Pivot is a cell type, and `neuronId` is a claim (invariant 8) every
id node downstream would then act on.

**The prefix is a param rather than a downstream Rename** because two of these meeting at one
Join is the ordinary case: `mean` and `max` from a trace matrix beside `mean` and `max` from an
adjacency is four columns of two names, and `core.join`'s suffix rule then names them `mean` and
`mean_r` — the case `foldNodeColumns` exists to stop, one picker with two answers of which the
second is stale. `zap_mean` beside `adj_mean` needs no rule at all. A trailing separator is
dropped rather than doubled, so `zap` and `zap_` both give `zap_mean`.

**Two params are in the provenance key and change no number**, which is what made the reduction
a memo. `Prefix` has to be in the key — it names the output columns (invariant 4), which is also
why it cannot be `presentational` — so every keystroke in that field re-enters `evaluate` with
the same arithmetic to do; and the **chips** decide which columns come out, where the single pass
computes all six of the cheap statistics regardless (`min` is two compares, Welford's `m2` two
multiplies, against a division for the mean that every ticking pays anyway). So the key is
`axis`, `Exclude diagonal` and whether `median` was asked for, and nothing else.

Measured on a 3,000 × 7,879 matrix: **108 ms** for the six single-pass statistics, **1,175 ms**
once `median` is ticked, and **0.0 ms** both for a prefix keystroke and for ticking any of the
six. Unticking `median` costs the 108 ms again. It is `heatmap.ts`' `SHAPED` idiom with **one
slot instead of four** — that file keeps four because two Heatmaps read one upstream matrix with
different tabs and a miss there is a Pyodide round trip, where here the keys number at most eight
and a session touches one or two — and what is held is `lines × 6` cells rather than a second copy
of the grid. The warnings are held with the answer and replayed, or the "Exclude diagonal was
ignored" line would vanish from a card the moment somebody typed a prefix, which is the cache
showing through. That capture-and-replay contract is now in five places (`heatmap.ts`,
`displayLabels.ts`, `editTable.ts`, `neuronSearch.ts`, here), each restating the reasoning; it
wants one helper beside `LruMap`, and this is the smallest of the five and a poor first caller
for it.

**The median is where real time is left on the table, deliberately.** The per-line sort is
~307M comparisons on that matrix — nine tenths of the 1,175 ms — and quickselect would be about
3.5× faster. It is not taken here because `quantileSorted` is the app's one definition of a
quantile, moved down into `core/stats.ts` precisely so there would not be two, and a selection
written in this file would be a second definition of the median. If it is wanted it belongs
beside `quantileSorted`, with the sort as its oracle.

**The strided axis was costed and measured away.** Reducing each *column* walks the
`Float64Array` with stride `cols`, eight times the cache lines, so a blocked gather per axis
looked necessary: measured, the six statistics take 108 ms down the rows against **114 ms**
across the columns, and with `median` ticked the strided walk is the *faster* of the two (929 ms
against 1,175). Both are bound by the 189 MB the grid occupies rather than by line fetches. A
second spelling of the arithmetic would buy 6 ms, so there is one index walk: a row is `cols`
cells one apart, a column is `rows` cells `cols` apart, and nothing below the stride mentions an
axis.

Empty chips are a legitimate state and mean **the labels alone**: a matrix's line names as a
table, which is a perfectly good thing to want. `emptyLabel` says so where the chips would be.

The schema is **derived, never observed**: every output column is named by a param, so the
pickers downstream fill as soon as the chips are ticked, with nothing run. Both emitters are
faithful and each says where its language differs — pandas' reductions *are* Coda's null rule
line for line (`skipna` by default, `sum` of an absent line 0, `std` at `ddof=1` and `NaN`
below two), while base R needs `coda_min`/`coda_max` for `min(x, na.rm = TRUE)`'s `Inf`, which
is `Group By`'s reason for the same two helpers.

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

**They also shared a bug, in mirror image, and the fix is `resolveFilterOp`.** An operator list is
per dtype but a param's `default` is one static value, so whichever a node declares is wrong for
some column: `Filter Table` opened on `ge` and `net.filter` on `contains`. A fresh Filter Table
pointed at a text column carried `"ge" does not apply to a str column` before anything had been
done to it, and a fresh Filter Network pointed at a number carried the same sentence about
`contains`.

**Only the declared default gives way.** That is `resolveColumn`'s rule — a declared default is not
a decision — so it resolves against the column actually wired, while a value somebody *chose* is
kept and `validate` still refuses it. The asymmetry is what stops this quietly changing an existing
filter.

**And an unknown dtype resolves nothing**, which is the half that is easy to get wrong:
`opsForDType(undefined)` answers the string ops, right for a dropdown and a licence to substitute
here. A Pivot publishes no schema until it has run, so on `Pivot → Filter Table` `validate` and both
emitters would see `undefined` and resolve `ge → eq` while `evaluate`, holding the real table, kept
`ge` — a notebook filtering differently from the card it was exported from, which is the divergence
going through one function was meant to prevent.

Two costs, both real. Choosing the node's own default value and then repointing at an incompatible
dtype resolves rather than complaining, because those are the same stored string. And the **stored
value is what the dropdown and the provenance key see**: a Filter Table on `ge` against a text
column shows `ge` in the Condition select — `SelectField` synthesises an option for a value outside
its list rather than rendering blank — while the node runs `eq`. Making the select show the
effective value was tried and reverted: at the UI layer the rule can only be "fall back to the first
option", which is right for these two params and wrong for the ones that deliberately keep a stale
pin (`dataset.*.version` would display *Latest* over a version the server has dropped, and the one
gesture that clears the error would fire no `onChange`).

Every reader goes through it: both nodes' `validate` and `evaluate`, and all four emitters, or the
notebook filters on a different condition from the card it was exported from.

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

## Heatmap: three tabs are data, the Colour tab is not

`out.heatmap` grew two things at once and a third later, and the split between them is the
design. **Colour** — scale, palette, printed values — is presentational: none of it enters the
provenance key, so restyling a four-million-cell picture is a repaint. **Labels**, **Filter** and
**Order** each change the matrix the node *outputs*, so all three are in the key, their tabs say
downstream nodes go stale, and a Table wired beside the heatmap, the CSV export and the notebook
all show what the card shows. The obvious alternative — a sort that lives in the drawing — was
rejected for exactly that reason: a picture sorted one way beside a table sorted another is two
answers to one question.

### The Labels tab is the same argument reaching the opposite answer from the Dendrogram's

`out.dendrogram` names its leaves from a wired annotation table **presentationally**: `evaluate`
never reads the port, both pickers are `presentational`, and the tree keeps the identity
`Selected to Neurons` matches on. That port is the reason this one exists, and copying it here was
refused. A heatmap's axis labels are read by the two tabs above, in `evaluate`, so a name only the
drawing knew about would put `LC4` on screen while a filter typed `LC4` matched nothing. So the
join runs **first**, ahead of the filter that matches on it and the order that sorts by it, and
`NBLAST`'s `Label by` is the standing precedent — "the labels are part of the matrix that leaves
the port, not a way of drawing it."

What it costs is stated rather than hidden: the axis stops carrying the id it arrived with, so a
`Linkage` below a named Heatmap clusters lines called `LC4`. That is the user's decision, made by
wiring a table, and the help says to put such a Linkage above rather than below. The join is
`displayLabels`, shared with the dendrogram — one operation whose two callers differ only in what
they do with the answer — and the write is `relabelMatrix` beside `takeMatrix`, identity return
and cells by reference. There is deliberately **no `Unmatched` control**: an unnamed line keeps
its own label, because blanks on an axis collide and the Filter box could no longer address them,
and the *count* is what the card says. Why the port is not a separate `Relabel Matrix` node, what
the two warnings are for, and what the exporters had to do differently are in
[viewers.md](viewers.md).

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
`orderPlan` says which axes lead and which follows; `orderIndices` turns that into one index
list per axis and `takeMatrix` applies them. Every criterion,
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

### Selecting rows and columns, and a bug the Labels tab exposed

A shift-dragged rectangle leaves the node as two tables. The gesture, why the selection is stored
as **labels** rather than as a rectangle, and how the bands are drawn are in
[viewers.md](viewers.md); what belongs here is the node half.

The selection is **positions** into the matrix this node outputs. It was the drawn labels first,
which survives a sort where positions do not — and it was reported as a bug within the hour,
because the Labels tab's whole purpose is to put one name on many lines: a box round one cell of
a fourteen-row `LC4` block took all fourteen. `chartSelection.ts` carries that argument and
[viewers.md](viewers.md) the gesture; what matters here is that `selectedLines` walks the *lines*
and asks whether each position is in the set, so the result is in the card's own order and a
position the matrix no longer reaches carries no row (invariant 5's corollary).

`SELECTION_SCHEMA` is three constant columns — `label`, `index`, `relabel` — and the first and
last exist because the Labels tab spends the axis's identity: `label` is what the line was called
on the way *in* (the id, on every route that does not name its axes), `relabel` what the card
showed. Positions made that pair more useful rather than less: selecting one row of an `LC4`
block now yields one row, and `label` is what says *which* `LC4` it was. Spelled `label` on purpose, since `Selected to Neurons` defaults its picker to exactly
that, so `Selected Rows → Selected to Neurons → 3D` wires with nothing to set. Keeping the pair
aligned is why `evaluate` carries the arrival names through the filter and the sort *through the
identical index lists*, which is what `orderIndices` returning lists rather than a matrix makes
possible — deriving `label` at the end from the drawn name cannot work, naming by type being
one-to-many by design.

**A selection is in the provenance key, so the reshaping is memoised.** It has to be in the key —
it decides two output ports — which means every drag, every alt-add and every ⌫ re-enters
`evaluate`. What it must not do is re-*run* the pipeline, and the top of that bill is not the
filter: with `Order by: clustering` it is `runClusterOrder`, which marshals the whole matrix
across the Pyodide bridge and caches nothing, so dragging a rectangle on a clustered heatmap
re-clustered it once per gesture. `SHAPED` is a `WeakMap` on the input value's identity keyed by
a signature of the params that actually reshape — `editTable.ts`'s `PLANS` idiom — with the
**warnings cached and replayed**, or a card would drop the "12 of 40 rows are not named" line it
had been showing the moment somebody selected something. It buys more than the arithmetic: the
reshaped matrix keeps its *identity* across a selection-only change, and the viewer keys its
extent scan, its fold and its zoom window on that object. A test pins it by counting bridge
calls, and was checked by mutation.

The join underneath it is memoised too, one layer down: `displayLabels` holds its answer against
the table it read (`WeakMap`, keyed inside by the column pair). `labelsByNeuron` is an `idText`
call per row, and both callers ask far more often than the answer changes — this node re-joins on
every keystroke in its Filter box, and `out.dendrogram` builds it during *render*, so a hover over
a tree re-walked the neuron table that named it.

**Both outputs are bound in the exporters whether or not anything is wired to them**, because an
emitter cannot ask who is downstream and a later cell naming an unbound variable is an error
rather than an empty table. `coda_matrix_selection` is the whole of the logic in both languages,
so a heatmap cell costs two lines for it. R's copy owns the **0-based/1-based seam** at both ends
— positions arrive as Coda's and are shifted to subscript with, `index` goes back out as Coda's —
and both halves of that are pinned by running the helper rather than by reading it. The type is
the part that bites: `picked` arrives as R numerics, so without an `as.integer` the `index` column
comes out a *double*, which a join downstream reads differently from the canvas's. `probe:r-helpers`
caught exactly that, on a change made to simplify the line.

**And it exposed a real bug in both exporters, which is the part worth keeping.** The Order tab
emitted *label* indexing — `df.loc[[...]]` in pandas, `m[c(...), ]` in R — which is correct only
while axis labels are unique, and the Labels tab makes repeats routine since naming rows by cell
type is what it is for. Measured on a 3×3 with two rows called `LC4`: **pandas returns five
rows**, because `.loc` with a duplicated label returns every match for each occurrence, and **R
silently drops one**, matching the first `LC4` twice while keeping the row count right so nothing
looks wrong. Two different wrong answers, both plausible, neither visible in a golden file. Every
arm is positional now — which made three of them *shorter*, since `leaves_list`, `hclust()$order`
and `order()` were answering in positions already and were being converted back to labels — and
the follower needed a helper (`coda_follow_order`) for the rule a comprehension cannot state:
the first **unclaimed** line of a repeated name wins. R's old spelling used `intersect`/`setdiff`,
which de-duplicate, so a follower with two lines of one name came back with one. Both are run
against a repeated-label matrix by `pnpm probe:helpers` and `pnpm probe:r-helpers`, including the
broken form, so the fix is measured rather than asserted.

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

## Embedding: three ways in, one k-NN graph

`core.embed`, `Add ▸ Analysis ▸ Embedding`. Linkage answers what the *groups* are; this answers
what the *neighbourhood* looks like, as two coordinates per neuron for a `Scatter Plot`.

### Why it is JavaScript, and what that costs

`umap-learn` requires `numba`, numba requires LLVM, and Pyodide ships neither — checked against
the pinned v314.0.5 lock rather than recalled: 356 packages, and none of them is `numba`,
`llvmlite`, `pynndescent` or `umap-learn`. So this could not have been the eighth Python
capability at any download budget, and it is PAIR-code's `umap-js`, dynamically imported into a
chunk of its own (30.5 kB gzipped; verified against `pnpm build` rather than assumed — the
library lands in a separate chunk and `main` carries only the wrapper).

**scikit-learn *is* there**, which is the road not taken and worth recording with its number:
t-SNE, PCA, MDS and spectral embedding, all with `metric='precomputed'`, for **scipy's 14.0 MB
plus scikit-learn's 4.4 MB** measured off the CDN — against a backend whose whole existing cost
is ten megabytes and whose seven capabilities declare the same two packages. A different answer
to the same question, priced.

What that costs is a claim this file makes about every other computed node and cannot make here.
`docs/python-pyodide.md` can say *fastcore's linkage **is** SciPy's*, merge order identical on
sixty trials and heights agreeing to 1.3e-15. Two UMAP implementations do not agree cell for
cell, and neither do two seeds of one. What is reproducible is **this implementation at this
seed**, which is what `Seed` is for: without it invariant 4 would need a nonce param, since the
cache key is provenance and a stochastic `evaluate` is exactly the hidden mutable state that
rule is about.

The seed is also what lets the **Annotations pickers be data** where `out.dendrogram`'s are
presentational. There a leaf's name is a drawing, so `Match on`/`Label by` stay out of the key
and trying `type`, then `hemilineage` re-runs no expensive Linkage. Here the label leaves the
node **in a table** that a Scatter Plot's colour picker reads, so it has to be in the key —
which means relabelling re-runs the embedding, and at a fixed seed the identical arrangement
comes back. A time cost rather than a moving picture.

### The three ports, and the one that is not a shortcut

Every route converges on a **k-NN graph**, because that is all UMAP consumes. A score matrix, a
table of feature vectors and a long table of nearest neighbours are three ways of writing one
down, so `nodes/lib/embedOps.ts` holds three adapters and `src/umap/run.ts` holds the one call —
rather than three code paths each of which has to be right about `minDist`.

| Port | Cost |
| --- | --- |
| `Matrix` | the n² is already paid by NBLAST or `core.similarity`; reading k per row off it is cheap |
| `Features` | builds that matrix **here**, through `similarityOps` |
| `Neighbours` | never builds one |

**The Features port is a convenience, not a scaling win**, and the guide says so rather than
letting the wording imply otherwise. Densifying the vectors and letting umap-js find its own
neighbours would escape the quadratic and is not available: umap-js takes `number[][]`, and
`Partner Vectors` keyed by partner id is a hundred thousand features wide, so the dense form is
refused by the crash floor long before the boxing is the problem. The port that escapes it is
`Neighbours`, fed by `NBLAST k-NN`, which scores `n × nCandidates` pairs.

**More than one wired is refused rather than ranked.** Nothing here makes "the matrix wins" a
defensible rule, and a silent precedence on an `expensive` node is a picture somebody believes
was computed from an input it ignored. Both `validate` and `evaluate` say it, naming the ports.

### Two conventions that fail silently, and one arbitrary choice

Neither of the first two is checkable from inside the library, and both produce a slightly wrong
picture rather than an error.

- **Row `i` names itself first, at distance 0.** `smoothKNNDistance` sums from index *1*
  (umap-js `umap.ts:363`, and umap-learn's `smooth_knn_dist` does the same), because the
  reference convention is that a point is its own nearest neighbour. Hand it `k` real neighbours
  with no self entry and the closest one is dropped from every bandwidth search.
- **Every row is exactly `k` long.** umap-js reads `knnIndices[0].length` in
  `computeMembershipStrengths` while `fuzzySimplicialSet` is handed `nNeighbors`, so a ragged set
  makes the two disagree about `log2(k)`. Short rows pad with `-1`, which the library already
  skips (`umap.ts:757`) — the same value `knnTable` drops on the way out of NBLAST k-NN, so both
  ends of that wire already meant the same thing by it.
- The arbitrary one: **a padded slot takes the row's own furthest real distance**, not infinity.
  `computeMembershipStrengths` skips a `-1` index outright, so the padded *distance* reaches only
  `smoothKNNDistance` — where an infinity makes the row's mean infinite and `result[i]` with it,
  one short row quietly destroying its own neighbourhood.

Three guards are `linkageOps`' rather than restated, because they are the same questions asked of
the same matrices: `transformFor` reads `MatrixValue.measure`; `checkLinkageDistances` refuses a
matrix of counts read as similarities before anything is laid out, UMAP embedding negative
distances as happily as fastcore clusters them; and `checkSquarePopulation` is the square-plus-
same-labels pair, which this file had forked into its own wording — two statements of one rule,
and the way they come to disagree about *what* is checked. Only the size rule differs, and
genuinely: a tree needs two observations and a neighbourhood needs four.

### Two numbers, both from the `n²` pass

Neither is a micro-optimisation; both are synchronous main-thread work in front of a progress bar
that has not moved yet, where the run they precede yields every 24 ms.

**The two matrix guards were two walks, and both used `for…of` over a `Float64Array`** — several
times slower than an indexed loop in V8. They take a shared `matrixStats` now, computed once:
**105 ms → 52 ms** on a 5000 × 5000 matrix, best of three. A **default argument** rather than a
second pair of functions, so a caller with nothing to save omits it and there is one spelling of
each guard. Linkage takes the same saving.

**The top-k per row is a bounded max-heap, not a rescan.** Rescanning all `k − 1` slots for the
new worst is fine on random data and bad on the data this node actually gets — a similarity
matrix ordered by cell type displaces the running top-k over and over. At `Neighbours`' maximum
of 200 and n = 3000: **325 ms random and 584 ms ordered against 195 and 124**; below about k = 20
the two are a wash, and there what pays is hoisting the `transform === 'one_minus'` string
compare out of the `n²` loop and dropping a per-cell running maximum that only a *short* row ever
reads — a short row is one where every finite cell was kept, so the largest kept distance already
is that number.

`Min distance` above `Spread` is refused at edit time. umap-learn refuses it outright; umap-js
does not, so an unfittable pair there comes back as an arrangement that merely looks wrong.

### The output, and why the columns are named that way

`label`, `umap1`, `umap2`, `annotation` — a **constant** schema, which is invariant 3 rather than
tidiness: a column named after whichever `Label by` was picked would make this the one node whose
output schema depends on a param's *value*, and every downstream picker would empty whenever the
pickers moved. `annotation` is present whether or not the port is wired, `partnerVectorSchema`'s
rule.

`label` rather than `neuronId` because **`cluster.cut` already emits `label`**, so
`Embedding ⋈ Cut Tree` on it is an ordinary `Join` with nothing configured — the embedding
coloured by cluster, which is the picture most of these workflows are after. An unannotated row
is `null` rather than its own label back, inverting `out.dendrogram`'s rule on purpose: there a
blank leaf is worse than the id it replaced because the name *is* the drawing, and here the label
is still in its own column, so a copy would put raw ids in a legend somebody is colouring by cell
type and give every unmatched neuron its own key.

### What it cost `out.scatter`

`resolveColumn`'s rule 3 hands a required picker still on its declared default the **first**
compatible column, and Scatter's `x` and `y` default to `pre`/`post`, which this table does not
have. So a freshly wired Scatter took `umap1` for both axes and drew a diagonal — on the pairing
this node exists for. Scatter's own `validate` had a check for exactly that symptom and could not
see it, because the check counted numeric columns (one was the case it knew about) rather than
asking what the two pickers resolved to. It asks now.

Fixed there rather than in `resolveColumn` deliberately: a "fall back to the *second* compatible
column" rule would have to be read identically by `scheduler.ts`'s cache-key pass, and a second
spelling of a column resolution is the disagreement invariant 5 exists to prevent.

The second thing that pairing wants is `Aspect: equal scale`, and only a browser shows it: a
scatter fills its card by default, and on a wide one that stretched a compact cloud of 401
neurons into a horizontal band. A UMAP's two axes carry the same units and nothing else, so
scaling them differently is a claim about the data. Not changed as a *default* — `out.scatter`'s
`aspect` help has named UMAP since before this node existed and the default serves every plot of
two real measurements — so it is said in the help document instead.

### The exporters

Both emit the reference rather than a translation, which is the reverse of every other node here:
`umap-learn` in the notebook, `uwot` in the R Markdown, hyperparameters carried across by name and
a `NOTE` saying the arrangement will differ in detail. Three implementations of one algorithm, and
no two of them draw the same picture — which two seeds of any one of them already do.

Four seams were read off a **running** package rather than off a manual, and are covered by
`pnpm probe:helpers` and `pnpm probe:r-helpers`: umap-learn's `metric='precomputed'` and its
`precomputed_knn=(idx, dists, None)`, and uwot's `dist` object and `nn_method = list(idx, dist)`
with `X = NULL`. The two `coda_umap_knn` helpers differ in exactly one thing, and it is the one
worth knowing: **uwot's `idx` is 1-based with no `-1` sentinel**, so a short row there pads with
its *own* index — which every implementation of this algorithm scores as a zero-weight self edge,
so it means what the sentinel means.

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
still Neurons with the same columns and nothing downstream loses a column picker. Both ports carry
`kinds: ITERABLE_KINDS` beside the `any` — see [adding-a-node.md](adding-a-node.md#portdefkinds-what-an-any-port-actually-means),
which is about the five nodes that make this same call and the surfaces that were believing them.

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

**A dtype clash is refused, not reconciled.** `neuronId` as a number on one input and text on
another is two different columns wearing one name. Widening both to text keeps every value and removes the column
from every numeric picker downstream; coercing text to a number loses values outright
(`Number('n/a')`). Neither is a decision this node has grounds to make, so it names the column,
both readings, and **which input states each** — the reading the earlier inputs agreed on, and the
first one that cannot be absorbed, which is the card that has to change rather than the one next
to it. It stops there. `i64` and `f64` are the exception and merge to `f64` silently: those are
the same kind of thing, and a count stacked onto a ratio is still a number.

The clash is **returned rather than thrown** by `stackColumns`, because both halves need it and
neither may throw — `inferOutputs` must not (invariant 2) and `validate` returns strings. Only
`stackTables` refuses, on exactly that list.

**A unit rides along only while every input agrees on it.** Nanometres stacked onto voxels is a
column with no single unit, and carrying one of them would label the others' rows wrongly.

**Rows keep input order and duplicates are kept** — `UNION ALL`, not `UNION`. Which of two
identical rows to keep is a real question with its own answer, and it belongs in the node that
asks it.

**Unknown until _every_ input is known.** The result's column set depends on all of them, so
publishing an answer while one is still missing would advertise a table without the columns that
input contributes, and a picker downstream would be configured against a shape that never arrives.
A dtype clash still publishes the union using the reading the earlier inputs agreed on — nothing is
built from it, since `evaluate` refuses on the same list, and it keeps the other columns pickable
while somebody fixes the one that clashes.

**Neurons only when every input is.** A `neurons` kind is a claim that the ids are neurons of a
dataset; a plain table that happens to carry a `neuronId` never made it. The type half and the value
half decide it the same way.

**As many inputs as you ask for**, one socket each, on an `Inputs` spinner — the shape
`Match Cell Types` established. It was a fixed pair chained for more, and the chain is what made
the source column mean two things: a stack refuses to add a column an input already has, so the
levels could not share a name, and only the *outermost* one partitioned the whole result. One card
labels every input once. Both halves of the migration are carried deliberately, because both fail
quietly, and both are **declared rather than spelled**: `PortGroupDef.formerIds` rewrites a stored
`top`/`bottom` handle onto `in1`/`in2`, so a share link keeps its wires, and `ParamBase.formerId`
moves a stored `topLabel` onto `label1` — an undeclared param is *ignored* by `normalizeParams`,
not migrated, so a label somebody typed would otherwise revert with nothing said. The old defaults
ride along in `absentMeans`, so a saved graph's source column holds the values it always did.
See [stackParams.ts](../src/nodes/lib/stackParams.ts).

**The source column is off by default and refused on a collision.** Empty adds none; a name adds a
`str` column holding `Input 1`, `Input 2`, … or whatever the labels say. Appended **last** rather
than first — it is this node's annotation, not part of any input, and pushing every real column one
place right on every stack reads as the data having moved. A name any input already uses is
refused rather than suffixed: the point of the column is to say where a row came from, and quietly
writing that into somebody's existing column is worse than untidy. The labels are `visibleIf` the
column is named **and** the arity — both conditions, ANDed by `repeatParams` rather than one
replacing the other — so neither a label for a socket nobody connected nor one on a stack that is
not labelling anything can stale a downstream result.

Worth knowing that a genuine clash is reachable with nothing but built-in nodes, which is what
`stack.test.ts` uses: `core.pivot`'s wide table types its label column `str` even when pivoted
from an `i64`, so a pivot on `weight` stacked onto the connectivity table it came from disagrees
about exactly that column. Note also that the pivot publishes no schema until it has run, so
`validate` cannot see that clash at edit time and does not pretend to.

That fixture used to pivot on **`preId`**, and what changed it is the thing this refusal is most
often met by. Every source publishes its id columns as `str` now
([invariant 8](invariants.md)), so `preId` reads `str` on both sides and stacks cleanly — which
is the whole point, since `neuronId` as a number above and text below was the *example* this
section led with and was in fact two spellings of one column rather than two columns. `weight` is
the honest replacement: genuinely `i64` on one side and a row label on the other.
