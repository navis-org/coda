## What the number actually is

Picture a pile of coins sitting on each of the neurons you want to query.

Every neuron passes its coins back to the neurons directly upstream of it, **split in proportion to how much of its input each one supplies**. A neuron that gets 60% of its synapses from A and 40% from B hands 60% of its coins to A and 40% to B. Then those neurons do the same, and so on, for as many rounds as `Max hops` allows.

Two rules on top of that:

- At every round the coins' value shrinks by `Gain`. At 0.5, a coin passed twice is worth a quarter.
- A neuron's **influence** is everything it collected, added up over all the rounds.

So with `Gain` at 0.5, and neuron Q of yours that takes 60% of its input from A and 40% from B, where A in turn takes all of its input from C:

```
C -100%→ A -60%→ Q ←40%- B
```

| Neuron | Route              | Influence           |
| ------ | ------------------ | ------------------- |
| A      | one hop, 60%       | 0.6 × 0.5 = **0.30** |
| B      | one hop, 40%       | 0.4 × 0.5 = **0.20** |
| C      | two hops, via A    | 0.6 × 0.5² = **0.15** |

That is the whole idea. A neuron scores highly by supplying a lot of the input, by being close, or by arriving along many routes at once — the score does not tell you which of the three it was.

**Every query neuron starts with its own pile — by default, the influence score is the SUM across your neurons, not the average.** See the `Seed weighting` and `Per query neuron` parameters below to change that behaviour.

> [!TIP] Influence is not a path
> A neuron can score highly with no strong single route, just many weak ones — and a neuron on
> the single strongest route can score poorly. If you want the routes themselves, use
> [Paths](#neuron.paths), which ranks whole chains by their weakest link. The two answer
> different questions and often disagree.

## Where this comes from

The measure is the influence score introduced in *Distributed control circuits across a
brain-and-cord connectome* — [Bates et al., Nature (2026)](https://doi.org/10.1038/s41586-026-10735-w).
It models the connectome as a linear rate network and asks what activity settles at every neuron
when a seed is stimulated. The reference implementation is
[ConnectomeInfluenceCalculator](https://github.com/DrugowitschLab/ConnectomeInfluenceCalculator).

That implementation solves the whole connectome at once — every neuron against every other. Coda
can't do that - first, downloading the entire graph is slow (if the backend even allows it)
and second, it's an expensive computation.

Instead, Coda offers a **bounded** version of the influence score:

1. It scores everything against the set of neurons you feed in, rather than every neuron against every other. The result still covers far more neurons than you wired in — just all measured relative to your set.
2. It only traverses the graph out to a limited number of hops, which is enough to recover most of the score.
3. We discard weak connections below a given threshold.

Bottom line: Coda's influence node is a fast approximation of the published implementation so it can
run in your browser.

### How "approximate" is Coda's influence score?

Measured against the reference implementation's own *C. elegans* connectome (300 neurons, 3,539 edges):
Coda's walk can only ever have left paths out, so a score here is a lower bound on the exact one.

At the default `Gain` of 0.5, against the exact answer:

| `Max hops` | Score recovered | Top 20 in the right order | Rank correlation |
| ---------- | --------------- | ------------------------- | ---------------- |
| 2          | 87.7%           | 18/20                     | 0.94             |
| 3          | 93.9%           | 19/20                     | 0.99             |
| **4** (default) | **97.0%**  | **19/20**                 | **0.998**        |
| 6          | 99.2%           | 19/20                     | 0.9998           |

So at the defaults the node recovers essentially the whole score and essentially the whole
ranking. Note how much faster the *ranking* settles than the magnitudes!

`Gain` matters much more than `Max hops` here, because it decides how much of the score lives
within reach at all:

| `Gain` at 4 hops | Score recovered | Top 20 in the right order |
| ---------------- | --------------- | ------------------------- |
| 0.5 (default)    | 97.0%           | 19/20                     |
| 0.75             | 76.8%           | 18/20                     |
| 0.9              | 42.2%           | 13/20                     |
| 0.99 (the package's default) | 6.5% | 6/20                   |

That last row is why Coda's default is not the package's — see `Gain` below.

Three caveats on those numbers. They are one 300-neuron connectome, so treat them as the shape of
the error rather than a guarantee for e.g. a fly dataset. They cover truncation only — `Min synapses`
and `Frontier limit` are separate losses. This node reports both, per run, as a percentage of
the signal. Also: Coda implements the package's input-fraction (`norm`) weighting rather than its
raw-synapse-count default.

## Interpreting the result

One row per neuron the walk reached.

| Column         | What it is                                                              |
| -------------- | ----------------------------------------------------------------------- |
| `influence`    | The score above. Bigger is more influential.                            |
| `influenceLog` | The same score, log-compressed the way the published package plots it. Use this for a heatmap or a colour scale; raw scores span many orders of magnitude and a linear scale shows you the top three and nothing else. |
| `hops`         | The first round at which the neuron received anything. Empty when the walk met in the middle, because then there are two distances and neither is *the* distance. |
| `isSeed`       | True for the query neurons you wired in. Filter these out to see everyone else. |

Three things to know before you read too much into a number.

> [!WARNING] Scores are comparable **within** one run, not across runs
> The scale depends on how many neurons you seeded, on `Gain` and on `Max hops`. Comparing a
> number from one card against a number from another with different settings means nothing. Set
> `Seed weighting` to *share of one* if you want two runs over different-sized sets to line up.

> [!WARNING] Every score is a lower bound
> Paths longer than `Max hops` are missing, and so is anything the `Frontier limit` dropped.
> Both can only have been left *out*, never added — so raising `Max hops` can raise a score and
> can never lower one. The node tells you how much it left out, as a percentage, whenever that
> is more than 1%.

> [!NOTE] Query neurons always come out on top
> A seed starts with its own coin, so it scores at least 1 before anything else happens. That
> matches the published implementation, which keeps them too. The `isSeed` column in the results
> is there so you can drop them.

## The typical pipeline

```coda-graph
caption: Which neurons most influence a set of LHONs.
dataset.hemibrain as ds
neuron.findNeurons as find { typePattern: "LHON.*" }
neuron.influence as inf
out.table as tbl
ds -> find
ds -> inf:dataset
find:neurons -> inf:neurons
inf -> tbl
```

The output is a **Neurons** table, not a plain one, so the top of the ranking goes straight into
[Skeletons](#neuron.skeletons), [Connectivity](#neuron.connectivity) or another Influence without
anything in between.

### A queries × influencers heatmap

```coda-graph
caption: Turn Per query neuron on, pivot, and draw it.
neuron.influence as inf { perQuery: true }
core.pivot as piv { rows: "type", columns: "queryType" }
out.heatmap as hm
inf -> piv
piv -> hm
```

`Pivot` is what turns the long table into a matrix: `Rows` and `Columns` pick the two axes and
`Values` is `influence`. Use `queryType` on one axis for a type-by-type picture, or `queryId` to
keep every query neuron as its own column.

`Heatmap`'s own `Order` tab will cluster both axes if you want the block structure, and its
`Colour` tab has the palettes. Scores span orders of magnitude, so plot `influenceLog` rather
than `influence` unless you have already narrowed to a comparable set.

Two more things people usually want next:

- **Group by cell type.** Influence adds up: the influence of a whole cell type is the sum of its
  neurons' scores. So an `Aggregate` on `type` is exactly right, with no correction needed.
- **Narrow to a class of neurons** — "which *sensory* inputs matter most?" The result carries only
  IDs and types, so join it against a [Find Neurons](#neuron.findNeurons) over the whole dataset
  to pick up `class` or `superclass`, then filter.

## Every setting, in plain terms

```coda-params
neuron.influence: direction, maxHops, minWeight, gain, denominator, includeFragments, frontierLimit, perQuery, seedWeighting
```

**`Direction`** — which way the coins travel.

*Upstream* means "what influences my neurons". The neurons you wire in are the **readout**, not
the thing being stimulated, and the answer is a score for everything that reaches them. This is
the usual question and it works on every backend.

*Downstream* means "what do my neurons influence". Now they are the thing being stimulated. This
needs `Denominator` set to published totals — see below.

**`Max hops`** — how many rounds of passing coins.

Four is a sensible start. More hops always reaches more neurons and always raises scores, never
lowers them. It costs one query per round, so it is not free — but the cost stops growing once
the walk stops finding new neurons.

**`Min synapses`** — ignore connections weaker than this.

Five is the published implementation's own threshold. Note that this does more than drop rows:
under the default `Denominator` it is applied **before** each connection's share is worked out,
so raising it makes every surviving connection look like a bigger fraction of the input.

**`Gain`** — how much of a signal survives each extra synapse.

0.5 means half survives per hop, so a two-hop route counts for a quarter. Lower means "I care
mostly about direct and near-direct input"; higher means "let long chains count".

This is exactly the `lambda_max` knob of the published implementation, whose default is 0.99. That
value is deliberately **not** the default here. At 0.99 the signal barely decays, so the score is
dominated by chains dozens of hops long — which a bounded walk cannot see, and which are much
the same for every seed anyway. Measured against the exact solve: at 0.5, four hops recovers 97%
of the true score and 19 of the true top 20 neurons; at 0.99, four hops recovers 6.5% and 6 of
the top 20. If you want to reproduce a published figure, set it to 0.99 and raise `Max hops` as
far as you can afford — and read the shortfall the node reports.

**`Denominator`** — how a connection's share of a neuron's input is worked out.

Both options are honest and they differ by the input sitting below `Min synapses`.

| Setting | What it divides by | Cost | Allows |
| --- | --- | --- | --- |
| *summed within the traversal* | The input list the walk already fetched | free | upstream only |
| *published totals, reconstructed partners only* | The neuron's total input from other neurons | one query per hop | everything |
| *published totals, all synapses* | Every synapse the neuron receives, fragments included | one query per hop | everything |

The default is the first, because it needs no extra query and works on every backend — but it can
only be worked out from the receiving end, so it cannot do `Downstream` and cannot meet in the
middle. Switch to published totals if you need either. They are only available where the dataset
publishes per-neuron synapse totals — today the neuPrint datasets and the Demo Data, but not
CAVE, CATMAID or a precomputed source.

**`Include fragments`** — whether unproofread bodies pass the signal on.

Off by default. A synaptic partner is very often a fragment the segmentation never promoted to a
neuron, and following those expands the walk enormously for neurons nothing downstream can look
up. What counts as proofread is set on the **Dataset** node, not here.

**`Frontier limit`** — the safety valve, and the only thing bounding cost.

Each round, only this many neurons carry their coins onwards — the strongest ones. Raise it if
the node warns that it discarded a meaningful share of the signal; lower it if a run is too slow.
Whatever it drops is reported as a percentage, so a limit that is biting is never silent.

**`Per query neuron`** — stop summing across your neurons, and emit the pairs instead.

Off, you get one row per influencer: the score summed over everything on the `Neurons` port. On,
you get one row per **query neuron per influencer** — the same numbers before they are added up —
with `queryId` and `queryType` naming which of your neurons the row is about.

That is what a queries × influencers heatmap needs. `Group By` on `neuronId` gets you back to the
plain ranking exactly, so nothing is lost by turning it on except size.

Two things change when you do. The output is **no longer a neuron set** — `neuronId` repeats once
per query neuron — so a wire straight into Skeletons or Adjacency will go red until you put a
`Group By` between them. And it cannot meet in the middle: the per-query split uses the same
machinery `Candidates` would, so with both in play the node walks the full depth and filters.
Same scores, more queries.

**`Seed weighting`** — whether a score is the sum or the mean across the neurons you wired in.

*One each* (the default) gives every seeded neuron its own coin, so a score is their **sum**. This is what the published implementation does, and it means seeding 50 neurons gives roughly ten times the scores of seeding 5.

*Share of one* splits a single coin between them, so a score is their **mean** instead. Use it when you want to compare two runs over sets of different sizes — otherwise the bigger set simply scores higher, whatever the biology.

The two differ by exactly a factor of the seed count, so switching reorders nothing within a single run.

## The `Candidates` input

Optional. Wire a second set of neurons into it and the result is restricted to those neurons —
"of *these* candidates, which influences my neurons most".

It never changes a score, only which rows come back. What it can change is the **cost**: with
`Denominator` on published totals, the node walks from both ends and meets in the middle, which
fetches far fewer neurons than going the whole way from one end. Under the default denominator it
cannot do that, and the node says so on the card before you run it — the scores are identical
either way, it is simply slower.

## Gotchas

> [!WARNING] `Downstream` needs published totals
> Going downstream, a connection has to be divided by what the *receiving* neuron takes in, and
> an outputs query never returns that. Set `Denominator` to one of the published-totals options,
> or use `Upstream`.

> [!WARNING] Drive that reaches a fragment is lost, not shared out
> With `Include fragments` off, a fragment's share of a neuron's input still counts in the
> denominator — it is simply not followed. That is deliberate: reassigning it to the neurons
> that remain would invent input that nobody reconstructed. The node reports the lost share.

> [!NOTE] Neuron level, always
> Unlike [Paths](#neuron.paths), this never collapses to cell types. The model is defined over
> individual neurons, and because influence adds up, a per-type total is just an `Aggregate` on
> the result — which is exactly right, where a type-level *walk* would be a different quantity.

> [!NOTE] Signed connections are not implemented
> The published package can flip the sign of a connection for inhibitory transmitters. This node
> does not, so a strongly inhibitory input scores as a strongly *influential* one. Read the
> result as "how much drive arrives from here", not "how much excitation".
