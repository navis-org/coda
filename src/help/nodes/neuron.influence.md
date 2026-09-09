## What the number actually is

Picture a pile of coins on each of the neurons you query.

Every neuron passes its coins to the neurons directly upstream, **split in proportion to how much of its input each one supplies**: a neuron taking 60% of its synapses from A and 40% from B hands 60% of its coins to A. Then those neurons do the same, for as many rounds as `Max hops` allows. At every round the coins' value shrinks by `Gain`, and a neuron's **influence** is everything it collected across all rounds.

With `Gain` at 0.5, for a query neuron Q taking 60% of its input from A and 40% from B, where A in turn takes all of its input from C:

```
C -100%→ A -60%→ Q ←40%- B
```

| Neuron | Route              | Influence           |
| ------ | ------------------ | ------------------- |
| A      | one hop, 60%       | 0.6 × 0.5 = **0.30** |
| B      | one hop, 40%       | 0.4 × 0.5 = **0.20** |
| C      | two hops, via A    | 0.6 × 0.5² = **0.15** |

A neuron scores highly by supplying a lot of the input, by being close, or by arriving along many routes at once — the score does not tell you which.

**Every query neuron starts with its own pile, so the score is the SUM across your neurons, not the average.** `Seed weighting` and `Per query neuron` change that.

> [!TIP] Influence is not a path
> A neuron can score highly with no strong single route, just many weak ones — and a neuron on the
> single strongest route can score poorly. For the routes themselves use
> [Paths](#neuron.paths), which ranks whole chains by their weakest link. The two often disagree.

## Where this comes from

The influence score of *Distributed control circuits across a brain-and-cord connectome* —
[Bates et al., Nature (2026)](https://doi.org/10.1038/s41586-026-10735-w). It models the connectome
as a linear rate network and asks what activity settles at every neuron when a seed is stimulated.
The reference implementation is
[ConnectomeInfluenceCalculator](https://github.com/DrugowitschLab/ConnectomeInfluenceCalculator),
which solves the whole connectome at once — every neuron against every other.

Coda offers a **bounded** version, so it can run in a browser: it scores against the set you feed
in rather than every neuron against every other, traverses only to `Max hops`, and discards
connections below `Min synapses`.

### How approximate is it?

Measured against the reference implementation's own *C. elegans* connectome (300 neurons, 3,539
edges) at the default `Gain` of 0.5. Coda's walk can only leave paths out, so a score is a lower
bound on the exact one.

| `Max hops` | Score recovered | Top 20 in the right order | Rank correlation |
| ---------- | --------------- | ------------------------- | ---------------- |
| 2          | 87.7%           | 18/20                     | 0.94             |
| 3          | 93.9%           | 19/20                     | 0.99             |
| **4** (default) | **97.0%**  | **19/20**                 | **0.998**        |
| 6          | 99.2%           | 19/20                     | 0.9998           |

The ranking settles well before the magnitudes do. `Gain` matters more than `Max hops`, because it
decides how much of the score lives within reach at all:

| `Gain` at 4 hops | Score recovered | Top 20 in the right order |
| ---------------- | --------------- | ------------------------- |
| 0.5 (default)    | 97.0%           | 19/20                     |
| 0.75             | 76.8%           | 18/20                     |
| 0.9              | 42.2%           | 13/20                     |
| 0.99 (the package's default) | 6.5% | 6/20                   |

Three caveats. These are one 300-neuron connectome — treat them as the shape of the error rather
than a guarantee for a fly dataset. They cover truncation only; `Min synapses` and `Frontier limit`
are separate losses, both reported per run as a percentage of the signal. And Coda implements the
package's input-fraction (`norm`) weighting rather than its raw-synapse-count default.

## Interpreting the result

One row per neuron the walk reached.

| Column         | What it is                                                              |
| -------------- | ----------------------------------------------------------------------- |
| `influence`    | The score above. Bigger is more influential.                            |
| `influenceLog` | The same score, log-compressed the way the published package plots it. Use it for a heatmap or a colour scale: raw scores span many orders of magnitude. |
| `hops`         | The first round at which the neuron received anything. Empty when the walk met in the middle, because then there are two distances and neither is *the* distance. |
| `isSeed`       | True for the query neurons you wired in. Filter these out to see everyone else. |

> [!WARNING] Scores are comparable **within** one run, not across runs
> The scale depends on how many neurons you seeded, on `Gain` and on `Max hops`. Set
> `Seed weighting` to *share of one* to line up two runs over different-sized sets.

> [!WARNING] Every score is a lower bound
> Paths longer than `Max hops` are missing, and so is anything the `Frontier limit` dropped. Both
> can only have been left *out*, so raising `Max hops` can raise a score and never lower one. The
> node reports how much it left out whenever that is more than 1%.

> [!NOTE] Query neurons always come out on top
> A seed starts with its own coin, so it scores at least 1 before anything else happens. That
> matches the published implementation. Drop them with the `isSeed` column.

## The typical pipeline

```coda-graph
caption: Which neurons most influence a set of LHONs.
dataset.hemibrain as ds
neuron.findNeurons as find { filters: "type matches LHON.*" }
neuron.influence as inf
out.table as tbl
ds -> find
ds -> inf:dataset
find:neurons -> inf:neurons
inf -> tbl
```

The output is a **Neurons** table, so the top of the ranking goes straight into
[Skeletons](#neuron.skeletons), [Connectivity](#neuron.connectivity) or another Influence.

Influence adds up, so a `Group By` on `type` gives the influence of a whole cell type with no
correction needed. To narrow to a class of neurons, join the result against a
[Find Neurons](#neuron.findNeurons) over the whole dataset to pick up `class` or `superclass`.

### A queries × influencers heatmap

```coda-graph
caption: Turn Per query neuron on, pivot, and draw it.
neuron.influence as inf { perQuery: true }
core.pivot as piv { rows: "type", columns: "queryType" }
out.heatmap as hm
inf -> piv
piv -> hm
```

`Pivot`'s `Values` is `influence`. Use `queryType` on one axis for a type-by-type picture, or
`queryId` to keep every query neuron as its own column. Plot `influenceLog` rather than
`influence` unless you have already narrowed to a comparable set.

## Every setting, in plain terms

```coda-params
neuron.influence: direction, maxHops, minWeight, gain, denominator, includeFragments, frontierLimit, perQuery, seedWeighting
```

**`Direction`** — which way the coins travel. *Upstream* means "what influences my neurons": they
are the readout, not the thing being stimulated. This is the usual question and works on every
backend. *Downstream* makes them the thing being stimulated, and needs `Denominator` on published
totals.

**`Max hops`** — how many rounds of passing coins. More hops always reaches more neurons and always
raises scores. It costs one query per round, but the cost stops growing once the walk stops finding
new neurons.

**`Min synapses`** — ignore connections weaker than this. Five is the published implementation's own
threshold. Under the default `Denominator` it is applied **before** each connection's share is
worked out, so raising it makes every surviving connection a bigger fraction of the input.

**`Gain`** — how much of a signal survives each extra synapse. 0.5 means a two-hop route counts for
a quarter. This is the `lambda_max` of the published implementation, whose default is 0.99 —
deliberately not the default here. At 0.99 the signal barely decays, so the score is dominated by
chains dozens of hops long, which a bounded walk cannot see and which are much the same for every
seed. To reproduce a published figure, set 0.99, raise `Max hops` as far as you can afford, and
read the shortfall the node reports.

**`Denominator`** — how a connection's share of a neuron's input is worked out. Both options are
honest; they differ by the input sitting below `Min synapses`.

| Setting | What it divides by | Cost | Allows |
| --- | --- | --- | --- |
| *summed within the traversal* | The input list the walk already fetched | free | upstream only |
| *published totals, reconstructed partners only* | The neuron's total input from other neurons | one query per hop | everything |
| *published totals, all synapses* | Every synapse the neuron receives, fragments included | one query per hop | everything |

The default is the first: no extra query, works on every backend, but it can only be worked out
from the receiving end, so it cannot do `Downstream` and cannot meet in the middle. Published
totals need a dataset that publishes per-neuron synapse totals — today the neuPrint datasets and
the Demo Data, but not CAVE, CATMAID or a precomputed source.

**`Include fragments`** — whether unproofread bodies pass the signal on. Off by default: a synaptic
partner is very often a fragment the segmentation never promoted to a neuron, and following those
expands the walk enormously. What counts as proofread is set on the **Dataset** node.

**`Frontier limit`** — each round, only this many neurons carry their coins onwards, strongest
first. The only thing bounding cost. Whatever it drops is reported as a percentage.

**`Per query neuron`** — off, one row per influencer, summed over everything on the `Neurons` port.
On, one row per **query neuron per influencer** — the same numbers before they are added up — with
`queryId` and `queryType` naming which. `Group By` on `neuronId` gets you back to the plain ranking
exactly.

> [!WARNING] Per query neuron breaks the neuron set
> `neuronId` repeats once per query neuron, so a wire straight into Skeletons or Adjacency goes red
> until a `Group By` sits between them. It also cannot meet in the middle: the per-query split uses
> the same machinery `Candidates` would, so with both in play the node walks the full depth and
> filters. Same scores, more queries.

**`Seed weighting`** — *one each* (the default) gives every seeded neuron its own coin, so a score
is their **sum**, and seeding 50 neurons gives roughly ten times the scores of seeding 5. *Share of
one* splits a single coin between them, making a score their **mean**, for comparing runs over
sets of different sizes. The two differ by exactly a factor of the seed count, so switching
reorders nothing within a run.

## The `Candidates` input

Optional. Wire a second set of neurons in and the result is restricted to those — "of *these*
candidates, which influences my neurons most".

It never changes a score, only which rows come back. It can change the **cost**: with `Denominator`
on published totals the node walks from both ends and meets in the middle, fetching far fewer
neurons. Under the default denominator it cannot, and the node says so on the card before you run.

## Gotchas

> [!WARNING] `Downstream` needs published totals
> Going downstream, a connection has to be divided by what the *receiving* neuron takes in, and an
> outputs query never returns that. Set `Denominator` to a published-totals option, or use
> `Upstream`.

> [!WARNING] Drive that reaches a fragment is lost, not shared out
> With `Include fragments` off, a fragment's share of a neuron's input still counts in the
> denominator — it is simply not followed. Reassigning it to the neurons that remain would invent
> input nobody reconstructed. The node reports the lost share.

> [!NOTE] Signed connections are not implemented
> The published package can flip the sign of a connection for inhibitory transmitters. This node
> does not, so a strongly inhibitory input scores as a strongly *influential* one. Read the result
> as "how much drive arrives from here", not "how much excitation".

Unlike [Paths](#neuron.paths), this never collapses to cell types: the model is defined over
individual neurons, and a per-type total is a `Group By` on the result.
