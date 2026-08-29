# Comparative connectomics

**Status: design, not yet built.** This is the record of the decisions taken before any code,
so that the first implementation argues with a written position rather than inventing one. The
reference implementation for most of it is `cocoa` (`mappers.py`, `cluster.py`, `compare.py`);
where this document departs from cocoa, it says so and why.

Coda can already put two brains in one *space* — `Transform Neurons` into `JRC2018U`, then
`Stack Neurons`, then NBLAST or a shared 3D View. See [xform](../src/nodes/transform/xform.ts).
This is the other axis: putting two brains in one *connectivity* frame.

## The problem, in three layers

The layers are independent and separately shippable, which is the single most useful thing to
know about this feature.

**L1 — correspondence.** `(dataset, id) → shared label`. Cell types are the smallest unit of
conservation across brains of a species, so the correspondence is a type mapping. It is not a
column lookup, because type labels are revised per dataset and not backported: the maleCNS
carries `type`, `hemibrainType`, `flywireType` and `mancType`, and four things can happen —

| in maleCNS | in FlyWire's namespace | what happened |
| --- | --- | --- |
| `type=A` | `flywireType=A` | nothing; the easy case |
| `type=A` | `flywireType=X` | renamed |
| `type=A` | `flywireType=X,Y` | two types merged |
| `type=A_a` and `type=A_b` | both `flywireType=X` | one type split |

cocoa's answer is a graph: neurons and labels as nodes, `id→label` and `label↔label` edges,
trimmed to the shortest neuron→label→neuron paths that actually *cross* datasets, then split as
far as it can be split without losing a crossing. Its connected components are the shared
labels. The worked example is in `mappers.py`'s module docstring and is worth reading before
touching any of this — in particular that **the answer changes with the number of datasets**:
`AOTU008a` and `AOTU008b` stay distinct across FlyWire-left and FlyWire-right, and collapse into
`AOTU008` the moment the hemibrain joins. A three-dataset mapping is therefore *not* two
two-dataset mappings composed, and anything that lets a user chain two mappers is offering a
plausible wrong answer with nothing on screen to say so.

**L2a — type-level edge comparison.** Relabel each dataset's edge list through L1, aggregate
`(preLabel, postLabel)`, put the datasets side by side. This is the "`a→b` is 4 synapses in A
and 40 in B" table, and it is cocoa's `Comparison`. **It needs no cross-dataset neuron ids at
all** — ids stay inside their own branch and the join key is a label. So the id problem does not
gate it, which is why it is the first cut.

**L2b — neuron-level co-clustering.** Both datasets' neurons on one observation axis, features
= shared labels; cluster; read the mixed clusters as matched groups. This is cocoa's
`Clustering`, and it is the one that needs qualified ids.

## Most of L2b already exists

Worth stating early because it changes the cost estimate. `Partner Vectors` emits **long** form
— one row per `(observation, feature, value)` — and `Similarity Matrix` reads long directly
without pivoting. So if the *feature* axis is relabelled through L1 and the *observation* axis
is dataset-qualified, then

```
Partner Vectors(A) ─┐
                    ├→ Stack Tables → Similarity Matrix → Linkage → Cut Tree
Partner Vectors(B) ─┘
```

is exactly `Clustering.compile`'s `vect_`, with `join="outer"` for free from the sparse long
form, and cocoa's `("downstream", label)` / `("upstream", label)` MultiIndex already spelled as
Partner Vectors' unconditional `out:` / `in:` feature prefix. Three things are genuinely
missing and each is small: `cn_frac_`, homogeneity-aware cutting, and a stated scale ceiling.
See [What L2b still needs](#what-l2b-still-needs).

## Decisions

Each is a decision that was actually taken, with the alternative that was rejected. Argue with
them; do not silently re-decide them.

### 1. A neuron carries its dataset as a qualified id: `flywire:720575940623374218`

Not a second `dataset` column forming a composite key. The composite key is more honest and
sorts properly, but every join, dedupe and group-by in the codebase keys on **one** column, so a
forgotten `dataset` column silently merges two different neurons — which is
[invariant 8](invariants.md)'s failure mode exactly one level up, and invariant 8 exists because
that class of bug is silent.

The qualified form has a property the composite key does not: **`isNeuronId` rejects it.** A
qualified id is not digits, so every query builder that splices ids — `neuprint/cypher.ts`, the
precomputed reader's `BigInt` — refuses it loudly instead of fetching the wrong neuron. That
inverts the failure from silent to noisy, which is the whole reason invariant 8 is written the
way it is. Keep `isNeuronId` strict; that strictness is now load-bearing for two features.

What it costs: `compareIds` (length-then-lexicographic) is no longer numeric order on a
qualified column, and there must be a qualify/unqualify pair at the two edges. Both are
explicit, and neither is silent.

**Where it is minted:** only where two datasets meet in one table. L2a never mints one. Do not
qualify ids "just in case" — a qualified id in a single-dataset branch is a neuron that can no
longer be looked up.

### 2. L2a first

Type-level edge comparison ships before co-clustering: it produces the headline result, it needs
no qualified ids, and it forces L1 to be built — which L2b then reuses whole.

### 3. `Match Cell Types` is a generic node with user-declared params

Not a per-source capability in `src/data`. cocoa's `MaleCNS.compile_label_graph` does a lot that
is dataset-specific — `mcns_group_` renaming, dropping singleton groups, parsing `{bodyId}_L`
instances, `MCNS_BAD_TYPES` — and moving that into `src/data` would bake one connectome's
annotation habits into the source layer and give a Custom backend nothing.

So the node takes the type columns, a bad-labels list and a compound separator as **params**.
Compound splitting (`PS008,PS009` → two edges) is generic and stays in the node. The maleCNS
group/instance cleanup is not, and in v1 the user does it upstream with `Filter` and `Rename` —
which is at least visible on the canvas. If per-source defaults are wanted later, they belong as
*pre-filled params the user can see and override*, never as hidden behaviour.

### 4. The mapper always reads the full annotation table

cocoa's `which_neurons="all"`, and this is not a performance footnote. The evidence that `A_a`
and `A_b` split from `X` very often sits entirely outside the neurons you selected. A node wired
only to two tables would produce a **different, wrong** mapping for the same pair of neurons
depending on what else the surrounding workflow happened to query — a silent, query-dependent
answer, which is the worst shape a result can have.

Consequences, all of which must be honoured:

- The node takes **Dataset** inputs, not just tables, and fetches each dataset's per-neuron
  attribute table itself.
- It requires the `neuronIndex` capability ([source.ts](../src/data/source.ts)) and **refuses
  with a message naming the source** where it is absent, rather than falling back to the wired
  rows. A fallback here is a different answer wearing the same node.
- It is `cost: 'expensive'` — [invariant 6](invariants.md). It is a multi-megabyte fetch per
  dataset and must not re-run per keystroke.
- It sets `dataCache: true`, since the annotation table is exactly what that cache is for.

### 5. Raw synapse counts. Normalisation is composed downstream

cocoa leaves `# TODO: normalised edge weights` in `Comparison.compile`, so there is nothing to
copy and no measured basis for choosing one. Rather than baking in a guess, `Compare
Connectivity` reports raw sums **and emits everything a normalisation needs**, so per-neuron
mean, input-fraction and global scaling are each a `Join` plus a `Combine Columns` away.

That is the composable answer and it is also the honest one: which normalisation is right is a
scientific question about the two datasets in hand, not a property of the node. But it leaves a
trap — **a `ratio` column computed from raw counts across two connectomes of different
completeness is meaningless, and looks authoritative.** The node must `ctx.warn` when the two
datasets' totals over the shared label space differ by more than a small factor. See
[limits.md](limits.md): a guard rail warns, it does not refuse.

### 6. A missing edge distinguishes *absent* from *unsampled*

An edge in A and not in B is `0` in B when both of its labels exist in B's neuron pool — a real
biological absence, and often the interesting result. It is `null` when either label is missing
from B, because then nothing was asked and zero would be a claim.

cocoa currently does neither: `Comparison.compile` intersects the labels present in all datasets
and drops the rest, which produces the cleanest table by discarding exactly the asymmetries the
comparison is for. Its own comment explains the reasoning — avoiding "50 synapses here, 0 there"
artefacts from unequal selection — and making the distinction a *column* answers that without
throwing rows away.

### 7. No sides in v1

Labels are type names; left and right neurons of a type share a label and pool together. For
whole-brain type-level comparison the sides largely cancel. cocoa's `sides_rel` (a partner's
side expressed relative to the query neuron's) is the correct treatment for mirrored comparisons
and is the natural v2 — note that it is a change to the *feature* axis, so it lands in Partner
Vectors, not in the mapper.

### 8. Composable primitives, and relabelling exists twice on purpose

Three nodes rather than one opinionated Compare node, consistent with the rest of Coda. But
`Compare Connectivity` relabels **internally** rather than demanding two upstream `Relabel`
nodes — that is the difference between a five-node comparison and a nine-node one, and the
relabelling it does is not a step anybody wants to inspect.

A generic `Relabel` node ships alongside anyway, because the L2b path needs to relabel the
feature axis of a Partner Vectors table and would otherwise grow a second, private spelling of
the same operation. One operation, two callers, one implementation in `nodes/lib/`.

## The prerequisite: variadic ports — **built**

`NodeDefinition.inputs` was a static `readonly PortDef[]`. The mapper is genuinely N-ary
(decision above: chaining is wrong), so this had to change first, and it has. The mechanism and
its rules are recorded in [core.md](core.md#variadic-ports--a-port-set-sized-by-a-param); what
belongs here is what the design predicted against what it cost.

**The shape it took.** `inputs`/`outputs` are lists of *slots*, where a slot is a `PortDef` or a
`PortGroupDef` — declarative, not a `(params) => PortDef[]` callback, because
`typesWithReferenceInputs` and `isReferencePort` both answer about ports with no node in hand
and a callback is opaque to them. `core/ports.ts` holds the one expansion and three named
resolvers. Arity is an ordinary `int` param, so it is saved, undoable and in the provenance key
without any new machinery.

**Making `inputs` a union type was the right call.** The alternative — leaving `inputs` alone
and adding an `inputGroups` field — compiles everywhere and is silently wrong at every site that
forgets the second field. The union broke compilation at 55 sites and the compiler became the
checklist: it found `assistant/apply.ts`, `assistant/catalogue.ts`, `help/figures.ts`,
`layout/elkGraph.ts` and `nodeguide/data.ts`, none of which the grep that scoped this work had
turned up.

**Three things predicted to bite, and what they actually did:**

1. **Variadic outputs followed from variadic inputs**, as expected — decision 9 gives the mapper
   one labels port per input dataset. The predicted trap was `inferOutputs` deriving its record
   from one count and the port list from another; the fix is that it does not derive it at all.
   `outputTypesFor` already seeds every declared output before `inferOutputs` runs, and
   `ctx.outputPorts()` hands the node the same resolved list the card draws, so there is one
   derivation and nothing to disagree with.
2. **Shrinking arity orphans edges** — handled in `setNodeParam`, inside the same graph
   transform so it undoes as one step.
3. **A saved file may name a port the current arity lacks** — handled in `deserializeGraph`.
   This one paid for itself immediately: validating *every* edge's handles, not just those on
   variadic nodes, found two test fixtures that had been wiring non-existent handles since they
   were written (`'table'` on a node publishing `out`, `'out'` on one publishing `neurons`).
   Both edges were inert — every walk looks edges up by port key, so nothing had ever asked for
   them. Healing was considered for the missing-handle case and rejected for the
   wrong-handle one: raising a node's count to cover an edge a file demands would be inventing an
   arity nobody chose.

**Two things the design did not anticipate.** Nothing forced a variadic node's *body* to agree
with the card about port ids — an `inferOutputs` writing `'labels' + i` would compile and look
right. That is the drift class this codebase is otherwise careful about, so `ctx.inputPorts()`
and `ctx.outputPorts()` were added to both contexts, and `ResolvedPort.group` carries
`{ repeat, index }` so a body reads its per-repeat params off the port rather than reconstructing
the id. Cost: `isPortGroup` moved from `node.ts` to `ports.ts` to keep the runtime import
one-way.

And the first cut let the *params* argument be optional, so "resolve for this node" and "resolve
for a fresh one" were the same call with an argument left off — which `help/figures.ts` had
already got wrong, its params being `Record<string, string>` and therefore never numeric. The
type-level reading now has its own name (`defaultInputPorts`), which makes forgetting the params
a compile error rather than a default-arity answer. Same shape as the `min`/`max` that a group
used to declare beside the param that already had them: two numbers nothing forced to agree, now
one.

**Scope held.** Ports are variadic; **params are not**. A node needing a setting per repeat
declares them to `max` and hides the surplus with `visibleIf` — hidden params are outside the
provenance key, so a picker past the current count cannot stale a run. That is the pattern
`Match Cell Types` will use for its per-dataset type-column pickers, and it needed no core
change at all.

## The mapper's pure core — **built**

`nodes/lib/typeMapping.ts`, with its tests in `typeMapping.test.ts`. `matchCellTypes` is the
whole of cocoa's `GraphMapper.compile`, headless and synchronous: annotation rows in — one
`{ id, labels[] }` per neuron per dataset — a per-dataset `id → shared label` map, a report and
an unmatched count out. Everything that has to *fetch* stays above it, which is what makes the
half that is hard to get right reachable from a plain unit test.

Its header records the five places it departs from cocoa. Three of them are decisions rather
than translation:

- **The bipartition is ours.** cocoa calls `nx.community.greedy_modularity_communities(best_n=2)`;
  this is the same Clauset–Newman–Moore agglomeration with an explicit tie-break on node index,
  because invariant 4 needs the result deterministic and CNM's merge order is otherwise dictionary
  order. The tie-break is the load-bearing part, and the reason it is *safe* to differ from
  networkx here is that the split is only a **proposal**: the dataset-coverage and ratio checks
  accept or reject it, so a different proposal costs granularity and never validity.
- **`COMPONENT_NODE_CAP` replaces `joblib`.** The trim is all-pairs shortest paths inside a
  component and the split is an agglomeration over it, so both are quadratic; cocoa parallelises,
  a browser cannot. Past 5,000 nodes the component is matched *without* being trimmed or split and
  `warnOverThreshold` says so, naming the likely cause — a component that large means one generic
  label is fusing everything, which is a bad-labels problem rather than a size problem. A coarser
  answer, not a refusal; the row is in [limits.md](limits.md) with the rest.
- **`labels: 'random'` is gone** (non-deterministic, invariant 4) and **`id` mode compares with
  `compareIds`** rather than `int()` (invariant 8). `id` needs a second pass over the finished
  mapping, because an id is unique only inside its own dataset and one both brains use would name
  two different groups; those ids are excluded from the choice rather than allowed to collide.

**Two things the design did not say, found by writing the tests.**

*A label only one dataset has can never name a shared group.* The trim drops it — it sits on no
crossing path — so in the merge case (`AVLP001` + `PS008,PS009` against `PS008` and `PS009`) the
group comes out `PS008` under `first` and `PS008,PS009` under `all`, and the maleCNS neuron's own
type appears in neither. That is correct and it is not obvious; a reader expecting `all` to list
every label the matched neurons carry will read it as a bug.

*cocoa's compound guards refuse more than they look like they do.* A compound is split only if no
part is a single character (`P1_17a,b` is one type with two suffixes, not two types) and it starts
with neither `(` (`(M_adPNm4,M_adPNm5)b`) nor `CB.` (`CB.FB3,4A9`). The single-character rule bites
harder than the other two: any toy example using `X,Y` silently does not split, which is exactly
how the first draft of the merge test failed. The two *prefixes* are a param
(`noSplitPrefixes`, pre-filled with both) rather than a constant, because they are one
connectome's naming habits and decision 3 says those are visible settings; the single-character
rule stays hardcoded, being a structural claim about type names rather than a habit.

*And "what a compound is" has to be one definition, not two.* The first cut had the graph builder
guarded and the *namer* splitting on the separator directly, so a label deliberately refused an
edge — `CB.FB3,4A9` — was split anyway when it came to name its group, putting text that is not a
type into a shared label. Both readings now go through `splittable`. This is the same failure the
codebase records over and over: the second spelling is the one nobody tests.

The report is cocoa's `get_label_counts` minus sides (decision 7), including the `suspicious` flag
at its ratio of 0.5 (`SUSPICIOUS_COUNT_RATIO`). What is **not** ported: `add_good_labels`, the
`strict` label-prefixing mode, and `add_graph_processor` — the first two are per-source annotation
habits that decision 3 keeps out of the mapper, and the third is a callback, which a node's params
cannot carry and a cache key cannot hash. Nor is cocoa's single-dataset branch: with one dataset
there is no correspondence to establish, so `matchCellTypes` matches nothing and counts every
neuron unmatched. "Which of this neuron's four type columns is the specific one" is a real
question and a good single-dataset transform, but answering it *here* would put a second
definition of what a shared label is inside the function that defines the first.

**What the node still owes this seam.** `MapperDataset` is deliberately a plain
`readonly MapperNeuron[]` — every output is index-aligned with the input array, so the dataset
*names* are the node's business and a `name` field in here would be a second place for them to
live. Two halves are therefore still unwritten and belong beside `matchCellTypes` when the node
lands, per [invariant 3](invariants.md): an input adapter (`TableValue` + id column + type columns
→ `MapperDataset`, which is where `idText` has to be used and where invariant 8 keeps getting
re-broken), and a `*Schema`/`*Table` pair for the report, whose columns are per-dataset and are
therefore the ones that can drift between `inferOutputs` and `evaluate`.

## The nodes

### `Match Cell Types` — `compare.matchTypes`

**Built** — [matchTypes.ts](../src/nodes/analysis/matchTypes.ts), around `matchCellTypes` in
[typeMapping.ts](../src/nodes/lib/typeMapping.ts). `category: 'analysis'`, `cost: 'expensive'`,
`dataCache: true`, max four datasets.

| | |
| --- | --- |
| **inputs** | `dataset1..N` (`T.dataset()`, variadic); `keep` (`T.table()`, optional) — labels allowed to survive with no counterpart |
| **outputs** | `labels1..N` (`T.table()`), each keyed by *that dataset's own bare* `neuronId`; `report` (`T.table()`); `network` (`T.network()`) — the label graph itself |
| **params** | `datasetCount`; per-dataset `typeColumns` (multi-column picker over that dataset's neuron schema); `badLabels`; `compoundSeparator` (default `,`); `labelMode` (`first` \| `all` \| `id`); `allowIndirect` |

**Bare ids on the labels ports, not qualified ones** — decision 1 says qualify only where two
datasets meet in one table, and these ports never do. It also means the downstream join is an
ordinary join on `neuronId`. The qualified form appears only on a combined output, which L2b
adds when L2b is built.

`labelMode` is cocoa's, verbatim: `first` takes the alphabetically first non-compound label,
`all` joins them with commas, `id` uses the lowest unambiguous neuron id. cocoa's `random` mode
is deliberately **not** carried over — a UUID per run is non-deterministic, and
[invariant 4](invariants.md) requires `evaluate` to be deterministic or to declare a nonce.

The **`report` port is not optional garnish.** It carries per-label neuron counts per dataset,
a `matched` flag, and cocoa's `suspicious` flag (`min/max < 0.5` between any two datasets' counts
for a label).
In practice this is where the biology gets checked — a label with 4 neurons in one brain and 40
in another is a mapping error, not a finding — and a mapping shipped without a way to see that
is a mapping that will be trusted when it should not be.

`inferOutputs` returns the static labels schema (`neuronId`, `label`) and must not fetch —
[invariant 2](invariants.md). It has nothing to fetch: the schema does not depend on the data.

#### Seven things settled in the building that the spec above did not say

**The report is emitted long** — `label | dataset | nNeurons | matched | suspicious`, one row per
label per dataset — rather than a count column per dataset. A column per dataset would make the report the
one output whose *schema* depends on the node's arity, which is exactly the shape
[invariant 3](invariants.md) exists for: `inferOutputs` and `evaluate` would derive the same
column names twice and agree until somebody renamed one. Long form makes it a constant, and it is
already how `Compare Connectivity`'s `counts` port is specified below.

**The mapping is derived and only derived — the `Synonyms` port was built and then removed.**
It carried hand-written `label ↔ label` edges (cocoa's `add_synonym`) at weight 0, on the
reasoning that an assertion about correspondence is not evidence about how many neurons carry a
label. It went because *it is never used in practice*, cocoa included — a socket, two `optional`
column pickers, a `validate` branch for the wired-but-unpointed-at case and a zero-weight edge
class in the graph, all for a route nobody takes. What that costs is real and is the thing to
weigh before reinstating it: `LC4` and `Lobula columnar 4` are the same cells under two naming
conventions, share no text, and nothing in the data will ever join them, so **this node has no
way to be told**. The answer is a downstream `Relabel`, where the assertion is a visible table
row rather than a setting on an expensive node.

Two consequences worth knowing. Every edge weight is now at least 1 — a `neuron → label` edge
weighs the group's neuron count, a compound's parts weigh how many neurons carry it — so
`greedyBipartition`'s `total === 0` guard is gone with it; anything reintroducing a zero-weight
edge has to put that guard back or the modularity gains become `0/0`. And a stored graph wired
into the old port loses that edge on load, which is the intended loss: `normalizeParams` reads
only declared params, so the two orphaned picker values fall out of the provenance key without
a migration.

**A sex-specific type is indistinguishable from a naming artifact, so the user says which.** Step
1 drops every component that does not reach all the datasets, and a male-only `pMP2` looks exactly
like a label one connectome invented: neurons in one brain, none in another. That default is right
— a label present in one brain only is not evidence of a correspondence, which is what step 1 is
*for* — and wrong whenever somebody already knows the type is genuinely unique. Hence the `keep`
port: a table, a column of type names, and those labels survive.

Four things about how it is built, in rough order of how badly each alternative would have gone.

**It is a separate pass, not a relaxed `coversAll`.** The coverage test is asked in four places —
twice in `partitionComponents`, once per split group in `splitCheckRecursive`, once at naming — and
each is load-bearing. An exemption threaded through them lets one exempt label carry a whole
component of *unexempt* ones past every gate, which is the silent-wrong-answer version of this
feature. `passThrough` instead runs after matching and only fills in neurons the matcher left
empty, so nothing about the correspondence changes.

**The report gained a `matched` column, and that is the price of admission.** A passed-through
label sits in the same name space as a matched one and is indistinguishable there by construction
— the exact trap `matchCellTypes`' docstring refuses to walk into for raw type names. The labels
table stays a flat `neuronId → label`; the answer to "was anything actually matched here" moved to
the report, beside the counts that show it. `suspicious` is now **never** set on a pass-through,
which is not leniency: an unmatched label has zero neurons in at least one dataset by definition,
so the ratio is 0 for all of them and the flag would fire on the entire pass-through list at once.

**Matching by text re-joins the datasets that do have it, for free.** A female-specific type in
both the hemibrain and FlyWire but not the maleCNS is dropped by step 1 for want of the third
dataset. Passed through, both sides get the same string and therefore correspond. Nothing arranges
this; it falls out of labels being shared by their text, which is the same property the whole
algorithm rests on.

**Three smaller rules, each the safe reading of a contradiction.** A derived label wins, because a
correspondence is better evidence than a list — so listing a type that does match is a no-op rather
than an override, which matters when the list is somebody's whole annotation wired in unchecked.
`badLabels` wins over `keepLabels`, because delete-this and keep-this are contradictory and the
destructive reading is the safe one. And the label keeps its own text whatever `labelMode` says,
including `id` mode: nothing was merged, so there is no group to name, and `#7` would replace the
one thing the user asked to see. That last one is why `passThrough` runs *after* `resolveIdLabels`,
which renames every label it is handed.

`unmatched` counts neurons with no label at all, so a passed-through neuron is not in it — one
definition, and the useful one, since the female-specific case above is a genuine correspondence.
What "matched with nothing on the other side" costs is a report row reading `nNeurons 0`.

**The graph is on a port, because the graph *is* the algorithm.** Neurons and labels as nodes,
`neuron → label` edges from the type columns and `label ↔ label` edges from compound splitting —
so a drawing of it is the only way to see why two types corresponded and why two others did not.
`network` carries it, `T.network()`, straight into the Network Viewer.

**There is no expanded mode, and the reason is that there was never a collapsed one.** cocoa
collapses neuron nodes as a post-step; `buildGraph` does it at construction — `builder.neurons(d,
ids)` puts every neuron sharing an identical label set into one node weighted by how many that
is, which is the number `collapse_neuron_nodes` gets by summing its edge list. So the collapsed
form is what exists and the *expanded* one would have to be reconstructed, at 140,000 nodes per
dataset. That is not a drawing, and a mode whose only honest use is a selection that the
downstream filter has not made yet is a mode that exists to be regretted.

Three smaller things. **Every component is on the port, including the ones step 1 dropped**,
because "why did these two not correspond?" is only answerable from a dropped one — which is most
of what an inspection port is for; `GRAPH_NODE_WARN` says the size out loud rather than letting a
viewer discover it. **Node ids are prefixed by kind** (`label/LC4`, `neurons/maleCNS:m1`): a label
is a string somebody typed into an annotation table, so one called `flywire:720575940623374218` is
possible, and unprefixed it would be the same id as the neuron group it names — `net.build`'s own
one-row-per-id rule would then merge two nodes with nothing to say so. And a node's `label` column
is **the matcher's** answer, so a pass-through is absent from it; that is right rather than a gap,
since `passThrough` deliberately does not touch the graph, and the report's `matched` column is
where it shows.

**The capability refusal happens before any fetch.** Every dataset is resolved and checked, then
all of them download concurrently. Four multi-megabyte indices followed by a refusal is the same
refusal, thirty seconds later.

**An unmatched fraction over half warns.** Not a threshold on cost — an attribution, in
[limits.md](limits.md)'s sense. A mapping covering a tenth of a brain produces a perfectly
ordinary pair of tables, and every comparison built on it then silently describes that tenth.

`noSplitPrefixes` also became a param here, per decision 3 — see the mapper's own section above.

**Not exportable, and the idea for fixing that.** Neither the notebook nor the R Markdown
exporter emits this node — `cocoa` is a dependency the Python exporter does not have and R has no
counterpart at all, so everything downstream of the mapper becomes a TODO too. The way out is
probably not an emitter: a mapping is a few thousand rows of small, stable, tabular data, which
makes it the strongest candidate for **bundling the result as a CSV beside the notebook** and
emitting a `read_csv` against it. Recorded in [export.md](export.md); nothing is scheduled.

**Left for the second consumer.** The per-dataset column pickers are generated in a loop in
`matchTypes.ts` — declared to `MAX_DATASETS`, hidden past the count with `visibleIf`, the port id
spelled once so `from` and `schemaFrom` cannot disagree. `Compare Connectivity` needs the same
shape four times over (three pickers plus a name, over a *pair* group), so that is the moment to
lift it into a `nodes/lib/repeatParams.ts` beside `limitParams.ts` — **built**, factored from two instances
rather than guessed from one, which is the rule `limitParams.ts`'s own header states. Copying the
loop instead is how the `from`/`schemaFrom` pairing comes apart, and a picker reading dataset 2's
schema while resolving against dataset 3 shows an empty column list, which reads as a schema that
has not arrived rather than as a bug.

### `Relabel` — `core.relabel` — **built**

`category: 'transform'`, `cost: 'cheap'`. A table, a mapping table, one column rewritten.
`nodes/table/relabel.ts` over `relabelSchema`/`relabelTable` in `nodes/lib/tableOps.ts`, which
is where it went rather than into a module of its own: it is a key lookup into a second table,
which is `joinTables`' shape, and the `*Schema`/`*Table` discipline this needs is that file's
whole subject.

| | |
| --- | --- |
| **inputs** | `in` (`T.table()`); `map` (`T.table()`) |
| **params** | `column` (in `in`); `keyColumn`, `valueColumn` (in `map`); `into` (new column name; empty = in place); `unmatched` (`keep` \| `null` \| `drop`) |

All column params resolve through `ctx.column()` — [invariant 5](invariants.md).

`unmatched` is the whole design. `keep` leaves an unmapped value alone, which is right for a
partial mapping; `null` marks it as not-corresponded, which is right when downstream must not
confuse "unmapped" with "mapped to itself"; `drop` removes the row, which is cocoa's
`ignore_unlabeled=True`. Defaulting to `keep` would silently mix raw type names into a shared
label space, where they look exactly like successfully-matched labels. **Default to `null`**, and
`relabel.test.ts` asserts that default rather than letting a later tidy-up read it as arbitrary.

**Five things the build settled**, each of which is a way to be wrong that answers plausibly:

1. **The mapping's value column decides the dtype, not the original's.** Relabelling a `str` type
   name through a table of cluster numbers gives a column of *numbers* — say otherwise and every
   numeric picker downstream is empty after a run, which is invariant 3's failure exactly.
   `unmatched: 'keep'` is the one case that widens, because it puts originals back in beside the
   mapped values; the pair goes through `mergedDType`, the stack's rule, falling back to text.
   The unit rides along only where the column is made *entirely* of mapped values.
2. **Matching is textual**, through `rowKey` rather than a second spelling of it — so a Relabel
   and a Join cannot come to disagree about whether two null-keyed rows are the same row. It
   follows that a null in the relabelled column pairs with a null key rather than matching
   nothing, and that a number and its text are one key. What it does *not* fix is
   [invariant 8](invariants.md): the mapper publishes `neuronId` as `str`, and a table carrying
   ids as `i64` carries float64s in which a wide CAVE root id stopped being itself upstream. The
   node's `validate` says so, because otherwise it reads as a mapping with holes in it.
3. **A repeated key is used once, first winning** — `joinTables`' rule, and for its reason: a
   mapping that disagrees with itself is not grounds to multiply rows.
4. **The result name is `relabelTarget`'s**, exported for the emitters rather than reconstructed
   by them: pandas' `df[name] = …` and R's `df[[name]] <- …` both *overwrite* a column of that
   name where this node suffixes. Typing the relabelled column's *own* name is the exception and
   means in place — `combineTable`'s rule, rather than the `type_2` that suffixing would hand
   somebody who spelled out what the empty field already means.
5. **It refuses at run time rather than passing the table through.** Unlike an `out.*` viewer —
   invariant 5's corollary — a Relabel that relabels nothing is a wire that silently stopped
   doing its job, so unset pickers throw. Reachable only before the schemas arrive, since
   `resolveColumn` falls back to a first column once there is one to fall back to; the two
   pickers' declared defaults (`neuronId`, `label`) are aimed at the mapper's `Labels` output for
   that reason, or both would resolve to the same first column of a two-column table.

**It exports, and that is the difference from `Match Cell Types`.** `coda_relabel` in both
languages, because all four rules above are ones the obvious spelling gets wrong while still
answering: `dict(zip(k, v))` keeps the **last** of a repeated key, `.map`/`recode` cannot tell "no
match" from "mapped to nothing", both match on the library's dtypes rather than on text, and
neither pairs a null with a null key. R's `match()` gets three of them right for free and needs
only the text rule stated; pandas needs all four. Both are run rather than read — `probe:helpers`
and `probe:r-helpers` execute the generated source out of the goldens, thirteen checks each.

### `Compare Connectivity` — `compare.connectivity` — **built**

`nodes/analysis/compareConnectivity.ts` over `nodes/lib/edgeComparison.ts`. `category:
'analysis'`, `cost: 'cheap'` — a relabel and a group-by over already-fetched edges.
The expensive nodes are upstream, which is what makes re-asking the question free.

| | |
| --- | --- |
| **inputs** | variadic pairs `edges_i` (`T.table()`) + `labels_i` (`T.table()`), aligned by index |
| **outputs** | `comparison` (`T.table()`); `counts` (`T.table()`) |
| **params** | `datasetCount`; `datasetNames` (what the weight columns are called); `pre`, `post`, `weight` column pickers over `edges_i`; `minWeight` |

`comparison` is `preLabel | postLabel | weight_<A> | weight_<B> | … | present_<A> | present_<B>`,
where `present_*` is what makes decision 6 readable: `weight` null with `present` true is a real
zero, `present` false means nothing was asked.

`counts` is `label | dataset | nNeurons | totalWeight` — the numbers a normalisation needs,
counted over **what the edge lists actually covered**, not over the mapper's full annotation
table. That distinction matters: per-neuron-mean normalisation wants the neurons in the
selection, and using the whole-dataset count would divide by neurons that contributed nothing.

Two inputs per dataset is not pretty. The alternative considered was one input taking a
`Stack Tables` of pre-labelled edges with a source column — genuinely more Coda-native and
needing no variadic ports here at all — and it was rejected because it forces the explicit
`Relabel` per dataset that decision 8 folds in. Revisit if variadic ports turn out worse than
expected.

`ctx.warn` when the datasets' totals over the shared label space differ by more than
`EDGE_TOTAL_RATIO_WARN` (decision 5). **That number is 3 and it is conventional, not measured** —
nobody has run the comparison that would set it, and the docstring says so rather than implying a
finding. The reasoning for shipping it anyway: the warning's job is the *ratio it prints*, which
is true whatever the threshold was, and the alternative of attributing on every run is a line
people learn to skip. Three rather than two because real pairs differ by about that much for
uninteresting reasons — hemibrain's volume truncates arbours FlyWire follows whole — so a floor of
two would fire almost always.

**Six things the build settled.**

1. **`counts` is `label | dataset | nNeurons | outWeight | inWeight`**, not the single
   `totalWeight` this record specified. One column cannot express two of the three normalisations
   decision 5 names: input fraction needs the label's *incoming* total, and a column summed over
   both ends double-counts every edge, which breaks global scaling too. Two columns cost nothing —
   same rows, still a constant schema — and make all three a `Join` plus a `Combine Columns`,
   which is what decision 5 promises. This is a departure from the design above, taken
   deliberately.
2. **`minWeight` drops a row only where *no* dataset reaches it.** Thresholding per dataset
   suppresses a value into a `0` that then means "below the threshold" as well as "really
   absent", and the column would need a third state to stay honest. As built, a pair carrying 1
   in A and 40 in B survives its own threshold — which is the asymmetry somebody set one hoping
   to see past, not the noise they meant to trim.
3. **`comparison` is wide and `counts` is long, and that is the same trade made twice.** The
   comparison's schema is *not* a constant — two columns per dataset, named after params — which
   makes it the first node whose published schema is derived rather than declared, and invariant
   3 has a real chance to fail. It is worth it because a comparison is read side by side. Nothing
   in `counts` is, so that half gets the mapper's report treatment and stays constant.
4. **Dataset names go through `uniqueName`.** Two datasets typed "A" would write one `weight_A`
   key into `makeTable` and the second would win — a table with a column silently missing rather
   than an error. `resolveDatasetNames` is exported for the emitters, `relabelTarget`'s reason.
5. **The Labels id/label pickers are shared, not per dataset.** Every Labels table in one
   comparison comes from the same `Match Cell Types` node, so they have the same two columns by
   construction; four copies would be four chances to point one at a column the others lack, for
   a case that cannot arise.
6. **`repeatParams` enforces rather than documents.** Factored at the second consumer, as
   recorded above — but two things it does are the point, and neither was in the plan. It takes
   the arity **param object**, not a bare `max`: `registerNode` already refuses a group whose
   repeat param lacks `min`/`max` because "the range lives on the param and nowhere else", and a
   `max: MAX_DATASETS` argument would have put that copy back one directory over, where the drift
   is silent in the worst direction (ports past the param range get no pickers at all). And the
   builder names a *port base* rather than writing `from` and `schemaFrom` itself, so the two
   cannot name different ports — a picker reading dataset 2's schema while resolving against
   dataset 3 shows an empty column list, which reads as a schema that has not arrived. The first
   draft only documented that rule; it now holds it.
7. **`ResolvedPort.group` gained `base`.** This is the first group repeating a *tuple*, and the
   first consumer immediately invented `port.id.startsWith('edges')` — a string-prefix test over
   ids `core/ports.ts` says a body should never assemble, which would also match a later
   `edgesExtra`. `expandPort` now carries the template's own id, so the filter is
   `port.group.base === 'edges'`.
8. **It exports, in both languages** — `coda_compare_connectivity`, fifteen probe checks each,
   run against real pandas and real R out of the goldens. Emitting it is *unreachable* in the
   common case, since `emit.ts` reports a node wired to an unemitted one as blocked and
   `compare.matchTypes` has no emitter. Written anyway for two reasons: the Labels port takes any
   table, so a hand-built mapping from `Upload Table` reaches this path today; and an excuse whose
   only ground is another node's absence rots invisibly the moment that node gets the bundled CSV
   [export.md](export.md) records.

## L2b — **built**

All five, on top of the pipeline that already existed
(`Partner Vectors → Stack → Similarity → Linkage → Cut Tree`).

1. **Qualified observation ids** — `Qualify Ids` (`core.qualifyIds`), both directions in one
   node, over `qualifyId`/`unqualifyId`/`qualifiedDataset` in [ids.ts](../src/core/ids.ts). It
   went to a node rather than a `prefix` param on `Stack Tables` because it is a real
   transformation somebody should see on the canvas, and because decision 1 requires a
   *pair* — a `prefix` on Stack has no natural home for the inverse. `isNeuronId` rejecting the
   result is asserted in the tests, since that property is the entire reason this form beat a
   composite key.
2. **A mapping-aware feature axis** — an optional `Labels` input on Partner Vectors, relabelling
   *before* the `out:`/`in:` prefix as the design said. It supersedes `Partners by` and `Untyped
   partners` rather than combining with them, and an unmapped partner is dropped: a feature
   outside the shared space can only exist in one dataset, so it cannot make two neurons alike
   or unalike. `validate` says so on the card, because `visibleIf` sees params and not which
   ports are wired.
3. **`cnFrac`** — a column on Partner Vectors' output plus a `ctx.warn` naming the **worst**
   neuron rather than a mean, since a mean over a thousand neurons hides exactly the neuron this
   is about. Emitted unconditionally (1 where nothing was dropped) so the schema does not change
   shape with whether an optional port is wired, and computed before the `fraction` weighting
   rescales the weights — after it, it would be a fraction of a fraction. It counts what
   `Untyped partners ▸ drop` removes too, which is the same subtraction by another route.
4. **Homogeneity-aware cutting** — a third mode on `Cut Tree`, reading each neuron's dataset off
   its qualified id, so it needs no second input. **It is not a port**: cocoa's
   `extract_homogeneous_clusters` was the reference for the goal, its source was not in hand,
   and `cutHomogeneous`' docstring says so and spells out the criterion instead. The criterion is
   *deepest* mixed clusters, not the first — the first draft descended only until a cluster was
   mixed, which emits the **root** almost every time, because a tree over two connectomes is
   mixed at the top by construction. That returns one cluster containing everything and looks
   like a working node; a test caught it.
5. **A stated ceiling** — in `Similarity Matrix`' guide, where the square matrix actually is:
   "low thousands… compare these three hundred neurons across two brains, not co-cluster two
   connectomes".

**Four of the five export.** `coda_qualify_ids` in both languages, and `coda_partner_vectors`
extended with `labels`/`cnFrac` in both — the Python and R probes assert the *same* arithmetic the
TypeScript tests do against the same fixture, which is what makes a drift between the three show
up as a disagreement rather than as three plausible answers.

**The mixed-dataset cut does not**, and emits a TODO. `cut_tree`/`cutree` both cut across the tree
at one level; this mode walks the merge matrix, which is a helper in each language rather than an
argument. Worth knowing how it was found: it originally *fell through* to the count branch and
emitted `cut_tree(n_clusters=4)` — a notebook that runs, returns four clusters, and is a different
analysis, with `4` being a default the user never saw because the control is hidden in this mode.
Both goldens now carry the refusal, which is what stops that recurring.

**Still open**, and deliberately: `sides_rel` (decision 7's v2), which is a change to the feature
axis and so lands in Partner Vectors beside items 2 and 3.

## Where the tests go

Per [testing-layers.md](testing-layers.md). The mapper is pure and headless, so its tests are
unit tests in `src/nodes/lib/` and should be built from cocoa's own worked examples — the
FlyWire-left/right case, the three-dataset AOTU008 collapse, the split and merge rows of the
table at the top of this document. Those four rows are the spec; a mapper that gets all four
right is very likely right.
