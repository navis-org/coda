# Node semantics — connectivity and networks

Nodes that ask a connectome how things are wired: traversal, paths, influence, similarity, graph
metrics, and the search that feeds them. One section per node whose behaviour cost a decision. See
also [adding-a-node.md](adding-a-node.md) and [nodes.md](nodes.md) for the index.

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
  in this table are the cells of `preId`/`postId`, so the declared dtype has to be theirs. The
  symptom this used to have is gone — both schemas said `str` for a CAVE root id and `i64` for a
  neuPrint one, so reading the wrong schema declared an 18-digit id as a float64 with nothing to
  say so until one arrived. Every source publishes `str` now ([invariant 8](invariants.md)), so
  the two agree about the id column; the rule stands because the table's *other* columns are
  still the connectivity schema's and nothing says the two must keep agreeing.
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

### Edge properties: what a connection carries beside its weight

`Edge properties` adds one column per property a connection carries beyond `weight`, named as the
dataset names it, after `weight` and before `roi`. The same list feeds Adjacency's `Weight` (which
property fills a cell) and Neuron Profile's `Count by` (what every partner list counts). Probed on
neuPrint rather than assumed:

| dataset | on `ConnectsTo` besides `weight` and `roiInfo` |
| --- | --- |
| fish2 | `weightHP`, `weightHR`, `weightAxonAxon`, `weightAxonDendrite`, `weightDendriteAxon`, `weightDendriteDendrite` |
| male-cns:v1.0, manc:v1.2.1, optic-lobe:v1.1 | `weightHP`, `weightHR` |
| hemibrain:v1.2.1 | `weightHP` |

**A picker of what discovery found, not an "everything" checkbox.** The checkbox was the first
idea, because it was not clear a dataset's edge properties could be listed at all. They can — see
[backends.md](backends.md#what-else-a-connection-carries-and-how-to-find-out) for the sample and why
it is not the exact schema call. A picker puts the chosen *names* in the provenance key and in the
schema, so a dataset that grows a property does not change what an existing node returns, and a
picker downstream is configured against columns that are promised rather than whatever turned up.
The names are advertised even when the dataset turns out not to publish one — `validate` says so,
and a column that came and went with discovery would clear the pickers pointing at it.

**Under the region options a property is read out of each region's breakdown, never off the
connection.** fish2's `roiInfo` carries the compartment weights region by region, and summed over
the primary set they reproduce the connection's own value — 200 of 200 sampled edges, and 422 of
422 connections of three strong seeds through the node's own query. `weightHP` and `weightHR` are
never in it. A whole-connection value repeated on every region's row is counted again by anything
that sums the parts, so `roiConnectivityCypher` does three things:

- a region entry **omits a zero**, so an absent key reads as 0 — but only on a connection whose
  breakdown names the property somewhere (`has[i]`, asked once per connection);
- a connection whose breakdown never names it answers **null**;
- a connection whose own value is 0 is 0 in every region.

Discovery records which properties it saw in a breakdown (`EdgeProperty.perRegion`), which labels
the picker and puts a note on the card, **and the query does not trust it.** `weightDendriteDendrite`
is never non-zero on fish2, so no sample can show it in a breakdown, and any rule refusing a property
the sample did not see would refuse it wrongly. Restricted but not split, each property is re-totalled
over the kept regions the way the weight is, and a null term makes the total null.

**Gated like the region options.** `capabilities.edgeProperties` is true on neuPrint and false on
CAVE and CATMAID, whose connection is a count of synapse rows with nothing else on it; an attached
edge set **removes** it, a file of `pre, post, weight` carrying nothing else. `connectivityFor` and
`adjacencyFor` refuse again at run time, for the graph repointed after it was set up. The three
cards share one message function, `edgePropertyIssues`, and one options function,
`edgePropertyOptions`.

**Profile swaps the property into `weight`** rather than threading a count-by argument through
`profileStats`: every roll-up there reads `weight`, and a dozen signatures that must agree is how
two tiles come to count different things. So `Min synapses` applies to the chosen count, and the
param stays presentational — no port carries a count.

**Exported through the canvas's own query.** `fetch_adjacencies` and neuprintr's connection table
return the weight and nothing else about a connection, so a property has no library route. Both
exporters run `connectivityCypher`/`adjacencyCypher` through `fetch_custom`/`neuprint_fetch_custom`,
with `CypherRendering` changing only what an exporter must: the id list becomes a placeholder
filled when the cell runs; so does the region list when a split covers the primary set (the canvas
resolves that list off the listing before it queries — omitting it split over every nested region,
which the first draft did); and the far end is labelled `:Neuron` unless fragments are included, the
libraries' own restriction. On this route R exports the region options its library route refuses,
the query text stating them itself. One hop only — the multi-hop helpers walk through the library
calls. The notebook cells were run against fish2; the R chunks were parsed and run with the fetch
stubbed, neuprintr not being installed.

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
less than one whole unit of drive in it. `combineHalves` also throws when `scored` is not as long
as the channelled half is wide, because that is the only way a second route to the same mistake can
announce itself — and it was the half of this fix that the notes claimed and the code did not have.
Both failure shapes are silent: too short and one neuron's influencers are filed under another's
name; too long and `channels[c]` reads off the end of the `Float64Array` into `undefined`, scores
`NaN`, and `influenceTable`'s `score > floor` drops the row, so the neuron simply is not in the
ranking. Nothing types the correspondence between a list and a channel index, which is why it has
to be asserted.

### The Transfers port costs no fetch at all, and it replaced a Network port

`propagate` has to compute each edge's contribution in order to propagate at all. What the `Transfers`
port adds is keeping that number rather than discarding it — one `Map` get and set per edge per
hop, behind an option that is off for every other caller. Nothing is fetched and nothing is walked
twice, which is the same claim the retired `Network` port made and is true here for a better
reason.

**Why the Network port went.** It emitted the induced subgraph of the top scorers, which drew well
and read wrongly, in three ways that compounded:

- **The drawn edges were a biased sample of the paths that made the numbers.** A node-link diagram
  invites a reader to trace a route and multiply. Most of a neuron's score arrives along paths that
  leave the top set and come back, so the tracing was wrong and nothing on the picture said so.
- **The arrow weights were not the quantity.** `influenceEdgeSchema` carried raw synapse counts,
  so thickness was synapses while colour was influence — two quantities in one drawing, and the
  thickest arrow routinely not the influential one.
- **The top scorers are mutually connected**, which is *why* they all score highly, so the induced
  subgraph is dense and recurrent and the layering filled with `back` and `within` edges. The
  `layer` column fixed the inverted arrows; it could not make a recurrent ball feed-forward.

A flow has none of those. Every ribbon is drive that actually crossed, so a column's total is the
whole of what reached that depth; the width *is* the quantity; and there is no layering to violate
because a hop is a column by construction. Removing it also retired `influenceNetwork`,
`influenceNetworkSchema`, `influenceEdgeSchema`, `flowLayer`, `NetworkHalf`, the `adjacency` field
on `PropagateResult` and the `Network nodes` param — about 200 lines, and a `networkx` dependency
in the notebook emitter.

The cost is that a saved graph wired to `Network` loses that edge on load, with the warning
`deserializeGraph` gives. **Deliberately not `formerIds`**: the port is a different *kind* of thing
now, so reconnecting the wire would hand a Table to whatever expected a Network and turn the next
card red. A dropped edge says what happened; a re-pointed one says something false.

Five rules, each of which the obvious version gets wrong.

**The grouping is chosen inside the walk.** Per neuron pair a four-hop ball is millions of entries
and the diagram it feeds is a few dozen boxes, so folding afterwards means materialising the thing
the fold exists to avoid. `PropagateOptions.ribbons` takes `'type'` or `'neuron'` and `propagate`
answers it from its own `types` map — an enum rather than a key function, because that map is
filled *during* the walk and a caller's closure over it would read something that does not exist
yet.

**An untyped body joins one bucket** (`MISSING_LABEL`) rather than becoming its own group. Falling
back to the id is right for a *table*, where a row per neuron is the point; here it puts an
18-digit root id in a diagram whose other boxes say `LC4`, once per body — and with
`Include fragments` on, that is most of them. What it costs is that the bucket can be the largest
thing in the picture, which is true and worth seeing.

**A ribbon runs presynaptic to postsynaptic**, which is a fact about the synapse rather than about
the walk, so it flips with `Direction`. Travelling `inputs` the propagation runs from `to` towards
`from` and the ribbon still reads the way the signal does. Getting this backwards is invisible in
the widths and produces a perfectly plausible diagram with every arrow reversed.

**`layer` is a drawing position and not the hop count.** Travelling upstream a hop count runs
*against* the signal — the seed is 0 and its influencers are 1, 2, 3 — so a diagram laid out by it
puts the seed in the first column and reports every connection as feedback. That is the same defect
the old `layer` column on the Network port existed for and which was reported there as inverted
arrows; `flowLayerOf` reverses it travelling `inputs` and leaves it alone travelling `outputs`.

**Nothing says where the drive went missing.** An earlier version emitted the fragment and frontier
losses as rows with no source, so the drawing could label them. It was wrong, and the flow tests
found it: those are two of *four* reasons a column carries less than the one before it — the others
being a neuron whose partners all fall below the weight threshold, which is a dead end rather than
a loss, and the hop budget running out. Labelling two of four accounts for part of a narrowing and
reads as though it accounted for all of it. So the shortfall is left to the geometry, where a
column's outflow minus its inflow is the whole of it, exact by construction; the *reasons* stay on
the card, where `ctx.warn` already gives each its own sentence and its own number. The upshot is
that `out.sankey` needs no concept from here at all: four columns of ordinary layered flow.

A ribbon into a body the walk goes on to drop **is** recorded, because the drive really did cross
that synapse. What stops is anything past it, so the diagram narrows at the next column, which is
the honest place for it.

**The port is empty under a meet-in-the-middle split**, which is `firstHop`'s rule one column over
and the same reason: the halves count hops from *opposite ends*, so a forward hop 1 sits beside the
candidates and a backward hop 1 beside the seeds, and folded through one layer formula they land in
the same column. The diagram's columns would then be two different measurements — plausible, and
invisible in the widths. Unlike the `hops` column, though, an empty *port* reads as a broken node,
so this one gets a `ctx.warn` naming the two controls that bring it back.

**The columns are numbered from a hop that is in the table** — not from the budget the walk was
given, and not from the depth it reached either. A four-hop budget that runs out of graph after two
would otherwise number its layers 2 and 3, leaving an empty column in front of them that a reader
of the table cannot tell from a filter. The drawing renumbers densely either way, so this is about
the table reading correctly on its own.

Counting from the depth *reached* was the first answer and it was half of one, for a reason that is
a property of the metric rather than an oversight: **an upstream walk conserves mass**, so every
hop's ribbons sum to the same total and a deeper hop merely spreads it over more cell-type pairs.
`Transfer floor` therefore takes whole *trailing* hops long before it thins a shallow one — on a
male-CNS ball the largest single ribbon fell from 9.3e-3 at hop 3 to 2.5e-4 at hop 6 against a
default floor of 2e-3 — and a hop whose every ribbon was floored away is exactly as absent from the
table as a hop the walk never took. Numbered from the deepest hop *walked*, a six-hop run whose
last two hops were floored came back as layers 2..5, and the dense renumbering made it invisible:
the identical diagram to a four-hop run, from a table whose `layer` counted from a column that is
not there. So `deepest` and `shallowest` are taken over the **kept** ribbons, and the mirror case
matters too — travelling `outputs` the layer is the hop count itself, so there the gap opens at the
shallow end. `flowLayerOf` and the notebook helper carry the same two lines, and both are tested in
both directions.

The reporting half of the same finding: the run *did* warn, and the warning was true and not
actionable — "Transfer floor left 57% of the drive out of the Transfers table" says nothing about
having removed the last two columns whole, which is the part somebody would have acted on.

`Transfer floor` is a **share** of the mass the walk started with rather than an absolute one, because
the total depends on `Seed weighting`: `each` starts one unit per seed, so an absolute floor would
mean ten times less on a ten-neuron set than on a one-neuron one.

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
neurons, worst relative difference 3.8e-16, under both denominators. The `Transfers` port is checked
there too, and the sharp one is **orientation** — 8,019 bands, none reversed — because a diagram
with every band the wrong way round is entirely plausible and invisible in the widths. Beside it:
that no layer carries more than the one nearer the seed, that the layer meeting the seeds carries
the whole seed mass, and that the flow is identical with `Per query neuron` on. That last one
needed the stub to type each neuron as itself: with every type null the whole diagram folds into
one box per layer and the orientation check has nothing left to compare. The one thing the cell does
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

### A node that asks nothing returns nothing

No rows, no region: no neurons. Not the whole dataset — that was the previous answer, and it was
honest and uniform across backends and cost a freshly-dropped card on hemibrain all 176,422
neurons including untraced fragments, fired at a shared production Neo4j the first time anybody
pressed Run.

It is **not** the old `Traced` default coming back, and the difference is the whole reason that one
had to go. `Traced` was a *filter nobody chose*, applied silently, which emptied the result on a
dataset with no `status` column and said nothing. This narrows nothing at all: it declines to ask,
says so through `ctx.warn`, and leaves the card's foot line reading `no filters — no neurons`
before anybody runs it.

**The decision is at the node, not at the seam.** `FindNeuronsRequest.rows` being empty still means
*no narrowing*, because `neuronIndex` and Explore's whole-table fetch reach the same method — a
source that learned this rule would break both. `asksNothing` in `nodes/lib/findNeuronsRows.ts`
owns it, one call above the seam, and four surfaces read it: `evaluate`, the card's foot line, and
both emitters, which write an empty frame rather than a cell fetching a connectome the canvas never
asked for.

**Two of the three controls, and only two, count as asking something.** `In ROI` does — it is not a
row only because a region is not a column, and a card set to `In ROI: LO(R)` is visibly asking a
question; a rule reading rows alone would answer it empty, which is this node's own worst failure
shape. `Limit` does not — a cap is not a question about *which* neurons, and "the first 100 of
everything" is an arbitrary sample of whatever order the backend returned. Saying "everything" on
purpose is still available and now has to be said: a `neuronId is not empty` row.

**What it cost:** the Workflow Wizard's Structured Search start builds exactly this card, so
`buildWorkflow` seeds that row — **on the synthetic dataset only**. The tour, the start page and a
node guide's demo link all open a graph somebody is being *shown*, and an empty chain shows
nothing; against a published dataset the same card is a question nobody has asked yet, and the
start's own hint says so. The seed changes what is written on the card, not what comes back.

### The size of the answer is said out loud

`FOUND_NEURONS_WARN`, 10,000, and it fires **after** the fetch because a match count is not
knowable before one — an admission about the answer rather than a guard rail before a wait, which
is why it is a plain `ctx.warn` and not `warnOverThreshold` (whose closing clause promises to go
ahead anyway, a sentence about work that has not happened). Deliberately not `MAX_NEURONS`, which
is the same number governing every geometry node's `Warn above`: two thresholds sharing a value and
answering different questions, and [limits.md](limits.md) records that tying one to the other is
precisely what a shared constant does. Not a `Warn above` control either, for a mechanical reason —
`warnAboveParam` spells that control `limit`, which this node already spends on a real `LIMIT`.

### The old params are gone

`typePattern`, `instancePattern`, `status` and `minSize` are deleted. `roi` stayed, being the one
that could never have been a row.

They outlived the row model by a release because of a **bridge**, and the bridge is worth recording
even though it is gone: they were kept declared and folded into rows by
`nodes/lib/findNeuronsRows.ts`, rather than migrated at load time, because `addNode` and
`defaultParams` never go through `deserializeGraph` — so a migration would have caught saved files
and missed the starter graphs, the export golden, and some fifty tests that built the node by
writing `{ typePattern: 'LC.*' }` directly.

Those fifty were the whole cost, and they are what made the deletion cheap in the end: every one of
them now says what it means in rows, through `test/findNeurons.ts`'s `searchFor`, which emits
**exactly** the rows the fold used to. That is the migration a load-time one could not perform, and
it is why the export goldens did not move — identical rows in, identical notebook out, which was the
assertion that mattered while doing it.

**What is left uncrossable is a `.coda.json` or a share link written by an alpha build**, and the
answer is deliberately not a migration. Such a file arrives holding four keys no definition
declares; `normalizeParams` reads only declared params, so the node is an unfiltered one — and
under the rule above that means it returns **no neurons and says so**, rather than silently
querying a connectome. That is the failure worth having, and it is why the two changes went in
in that order: had the params been deleted first, the same file would have quietly become a
whole-dataset query.

The one thing the deletion did break is the **assistant**, which could set `typePattern: 'LC.*'`
and now faces `filters`, an `ids` param holding JSON. `findNeurons.ts`'s `filtersNote()` therefore
rides on `ParamBase.catalogueNote` — the row shape and the operator vocabulary, **generated by
reading `ALL_ROW_OPS` and `arityOf`** rather than transcribed, because drift there is the bad kind: a plan
naming an operator that no longer exists is refused with a message about the *param*, which reads
to a model as "filters is wrong" rather than "that operator is gone". The other two `ids` params —
`out.table`'s clauses and `core.rename`'s remappings — are deliberately not covered, since one rule
generalising over "ids params" would be three grammars under one name.
