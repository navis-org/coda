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
| **inputs** | `dataset1..N` (`T.dataset()`, variadic); `extra` (`T.table()`, optional) — extra `label↔label` edges, cocoa's `add_synonym`, and the route for a hand-curated correspondence |
| **outputs** | `labels1..N` (`T.table()`), each keyed by *that dataset's own bare* `neuronId`; `report` (`T.table()`) |
| **params** | `datasetCount`; per-dataset `typeColumns` (multi-column picker over that dataset's neuron schema); `badLabels`; `compoundSeparator` (default `,`); `labelMode` (`first` \| `all` \| `id`); `allowIndirect` |

**Bare ids on the labels ports, not qualified ones** — decision 1 says qualify only where two
datasets meet in one table, and these ports never do. It also means the downstream join is an
ordinary join on `neuronId`. The qualified form appears only on a combined output, which L2b
adds when L2b is built.

`labelMode` is cocoa's, verbatim: `first` takes the alphabetically first non-compound label,
`all` joins them with commas, `id` uses the lowest unambiguous neuron id. cocoa's `random` mode
is deliberately **not** carried over — a UUID per run is non-deterministic, and
[invariant 4](invariants.md) requires `evaluate` to be deterministic or to declare a nonce.

The **`report` port is not optional garnish.** It carries per-label neuron counts per dataset
and cocoa's `suspicious` flag (`min/max < 0.5` between any two datasets' counts for a label).
In practice this is where the biology gets checked — a label with 4 neurons in one brain and 40
in another is a mapping error, not a finding — and a mapping shipped without a way to see that
is a mapping that will be trusted when it should not be.

`inferOutputs` returns the static labels schema (`neuronId`, `label`) and must not fetch —
[invariant 2](invariants.md). It has nothing to fetch: the schema does not depend on the data.

#### Four things settled in the building that the spec above did not say

**The report is emitted long** — `label | dataset | nNeurons | suspicious`, one row per label per
dataset — rather than a count column per dataset. A column per dataset would make the report the
one output whose *schema* depends on the node's arity, which is exactly the shape
[invariant 3](invariants.md) exists for: `inferOutputs` and `evaluate` would derive the same
column names twice and agree until somebody renamed one. Long form makes it a constant, and it is
already how `Compare Connectivity`'s `counts` port is specified below.

**Both synonym column pickers are `optional`.** Required, each would fall back to the *first
compatible column* of the wired table — the same column for both — so every row would assert that
a label is a synonym of itself, and the port would silently do nothing. Optional makes empty a
decision; a *wired* table with nothing chosen is the one reading of empty nobody intends, so
`validate` says so.

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
lift it into a `nodes/lib/repeatParams.ts` beside `limitParams.ts` — factored from two instances
rather than guessed from one, which is the rule `limitParams.ts`'s own header states. Copying the
loop instead is how the `from`/`schemaFrom` pairing comes apart, and a picker reading dataset 2's
schema while resolving against dataset 3 shows an empty column list, which reads as a schema that
has not arrived rather than as a bug.

### `Relabel` — `core.relabel`

`category: 'transform'`, `cost: 'cheap'`. A table, a mapping table, one column rewritten.

| | |
| --- | --- |
| **inputs** | `in` (`T.table()`); `map` (`T.table()`) |
| **params** | `column` (in `in`); `keyColumn`, `valueColumn` (in `map`); `into` (new column name; empty = in place); `unmatched` (`keep` \| `null` \| `drop`) |

All column params resolve through `ctx.column()` — [invariant 5](invariants.md).

`unmatched` is the whole design. `keep` leaves an unmapped value alone, which is right for a
partial mapping; `null` marks it as not-corresponded, which is right when downstream must not
confuse "unmapped" with "mapped to itself"; `drop` removes the row, which is cocoa's
`ignore_unlabeled=True`. Defaulting to `keep` would silently mix raw type names into a shared
label space, where they look exactly like successfully-matched labels. **Default to `null`.**

### `Compare Connectivity` — `compare.connectivity`

`category: 'analysis'`, `cost: 'cheap'` — a relabel and a group-by over already-fetched edges.
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

`ctx.warn` when the datasets' totals over the shared label space differ by more than ~3×
(decision 5). This number is a placeholder until somebody measures a real pair.

## What L2b still needs

When co-clustering is built, on top of the above:

1. **Qualified observation ids** — a `Qualify Ids` node, or a `prefix` param on `Stack Tables`.
2. **A mapping-aware feature axis** — `Relabel` on the `feature` column of Partner Vectors'
   output. Note the features are prefixed `out:` / `in:`, so `Relabel` either needs to see
   through the prefix or Partner Vectors needs to relabel before prefixing. The latter is
   right: add an optional `Labels` input to Partner Vectors.
3. **`cn_frac_`** — the fraction of each neuron's synapses surviving the label restriction.
   cocoa reports mean and worst-case and offers `cn_frac_threshold`. Without it a neuron
   represented by 5% of its connectivity clusters as noise and nothing says so. It belongs as a
   column on Partner Vectors' output plus a `ctx.warn` on the worst case.
4. **Homogeneity-aware cutting** — cocoa's `extract_homogeneous_clusters`: cut the dendrogram so
   each cluster draws from all datasets in sensible proportion. A mode on `Cut Tree` reading a
   dataset column, not a new node.
5. **A stated ceiling.** `SIMILARITY_WORK_WARN` is 500M pair-features; a 30k × 30k float32
   matrix is 3.6 GB and is not a browser artefact. cocoa clusters tens of thousands of neurons;
   Coda will do low thousands. That is a real limit on what this feature is *for* — "compare
   these 300 neurons across two brains", not "co-cluster two connectomes" — and it should be
   said in the node's guide rather than discovered at the crash floor.

## Where the tests go

Per [testing-layers.md](testing-layers.md). The mapper is pure and headless, so its tests are
unit tests in `src/nodes/lib/` and should be built from cocoa's own worked examples — the
FlyWire-left/right case, the three-dataset AOTU008 collapse, the split and merge rows of the
table at the top of this document. Those four rows are the spec; a mapper that gets all four
right is very likely right.
