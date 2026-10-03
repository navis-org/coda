## What Influence does

Influence scores neurons by how strongly they drive (or are driven by) the neurons you wire in, taking every path between them into account at once rather than a single route. It implements the influence score from *Distributed control circuits across a brain-and-cord connectome* ([Bates et al., Nature 2026](https://doi.org/10.1038/s41586-026-10735-w)).

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

## How it works

Picture a pile of coins on each of the neurons you query.

Every neuron passes its coins on to the neurons directly upstream of it, split in proportion to how much of its input each of them supplies: a neuron getting 60% of its synapses from A and 40% from B hands 60% of its coins to A and 40% to B. Those neurons then do the same, for as many rounds as `Max hops` allows. With every round, the coins lose value by a factor of `Gain`. A neuron's influence is the total it collected over all rounds.

For example, with `Gain` at 0.5, take a query neuron Q that gets 60% of its input from A and 40% from B, where A in turn gets all of its input from C:

```
C -100%→ A -60%→ Q ←40%- B
```

| Neuron | Route              | Influence             |
| ------ | ------------------ | --------------------- |
| A      | one hop, 60%       | 0.6 × 0.5 = **0.30**  |
| B      | one hop, 40%       | 0.4 × 0.5 = **0.20**  |
| C      | two hops, via A    | 0.6 × 0.5² = **0.15** |

A neuron can get a high score by supplying a large share of the input, by being close, or by connecting through many routes at once. The score alone does not tell you which.

Every query neuron starts with its own pile of coins, so by default a neuron's score is the *sum* over all your query neurons, not the average. `Seed weighting` and `Per query neuron` change that (see below).

> [!TIP] Influence vs. Paths
> A neuron can score highly without any strong single route, just through many weak ones. And a
> neuron on the strongest single route can have a low score. If you want the routes themselves,
> use [Paths](#neuron.paths), which ranks individual routes by their weakest link. The two often
> disagree.

## Accuracy

The reference implementation, [ConnectomeInfluenceCalculator](https://github.com/DrugowitschLab/ConnectomeInfluenceCalculator), solves the whole connectome at once. To run in a browser, Coda uses a bounded version instead: it only follows connections up to `Max hops` away and ignores connections below `Min synapses`.

Because the bounded version can only leave paths out, each score is a lower bound on the exact one. To give you an idea of how close it gets, here is a comparison against the reference implementation on its own *C. elegans* connectome (300 neurons, 3,539 edges) at the default `Gain` of 0.5:

| `Max hops`      | Score recovered | Top 20 in the right order | Rank correlation |
| --------------- | --------------- | ------------------------- | ---------------- |
| 2               | 87.7%           | 18/20                     | 0.94             |
| 3               | 93.9%           | 19/20                     | 0.99             |
| **4** (default) | **97.0%**       | **19/20**                 | **0.998**        |
| 6               | 99.2%           | 19/20                     | 0.9998           |

The ranking settles well before the scores themselves do. `Gain` matters more than `Max hops`, because it decides how much of the score is within reach at all:

| `Gain` at 4 hops             | Score recovered | Top 20 in the right order |
| ---------------------------- | --------------- | ------------------------- |
| 0.5 (default)                | 97.0%           | 19/20                     |
| 0.75                         | 76.8%           | 18/20                     |
| 0.9                          | 42.2%           | 13/20                     |
| 0.99 (the package's default) | 6.5%            | 6/20                      |

A few caveats:

- This is a single, small connectome, so treat these numbers as a rough guide for fly datasets rather than a guarantee.
- They only cover the effect of `Max hops`. `Min synapses` and `Frontier limit` lose signal too; the node reports both after each run as a percentage of the signal.
- Coda uses the package's input-fraction (`norm`) weighting, not its default of raw synapse counts.

## Reading the result

The `Influence` output has one row per neuron the walk reached:

| Column         | Description                                                             |
| -------------- | ----------------------------------------------------------------------- |
| `influence`    | The score. Bigger means more influential.                                |
| `influenceLog` | The same score, log-compressed the way the published package plots it. Raw scores span many orders of magnitude, so use this one for a heatmap or a colour scale. |
| `hops`         | The round in which the neuron first received anything. Empty if the search met in the middle (see `Candidates` below), because the distance is then ambiguous. |
| `isSeed`       | True for the query neurons you wired in. Filter on it to see everyone else. |

> [!WARNING] Compare scores within a run, not across runs
> The scale of the scores depends on how many neurons you seeded, on `Gain` and on `Max hops`.
> To compare two runs over differently sized sets of neurons, set `Seed weighting` to
> "share of one".

> [!WARNING] Every score is a lower bound
> Paths longer than `Max hops` are missing, and so is anything dropped by `Frontier limit`.
> Raising `Max hops` can therefore raise a score but never lower it. The node tells you how much
> was left out whenever that is more than 1%.

> [!NOTE] Query neurons come out on top
> Query neurons start with their own coins, so they score at least 1 before anything else
> happens. This matches the published implementation. Use the `isSeed` column to drop them.

## What to do with it

The `Influence` output is a neuron table, so you can wire the top of the ranking straight into [Skeletons](#neuron.skeletons), [Connectivity](#neuron.connectivity) or another Influence.

Influence scores add up, so a [Group By](#core.groupBy) on `type` (summing `influence`) gives you the influence of each cell type. Influence never collapses neurons into cell types itself, unlike [Paths](#neuron.paths). To narrow the result down to a class of neurons, [Join](#core.join) it with a [Find Neurons](#neuron.findNeurons) over the whole dataset to pick up `class` or `superclass`.

To see which query neuron is influenced by what, turn on `Per query neuron` and pivot the result into a heatmap:

```coda-graph
caption: Turn on Per query neuron, pivot, and draw a heatmap.
neuron.influence as inf { perQuery: true }
core.pivot as piv { rows: "type", columns: "queryType" }
out.heatmap as hm
inf -> piv
piv -> hm
```

Set the [Pivot](#core.pivot)'s `Of column` to `influence`. Use `queryType` for the columns to get a type-by-type picture, or `queryId` to give every query neuron its own column. Unless you have already narrowed things down to a comparable set, plot `influenceLog` rather than `influence`.

## The Transfers output

`Transfers` records how the drive travelled during the walk: one row per pair of cell types and hop, with columns `layer`, `source`, `target` and `value` (how much drive crossed from `source` to `target`). It is meant for a Sankey, which shows where the drive came from and what it passed through on the way. Neurons without a type are pooled into a single "—" box. Building this table needs no extra queries.

Rows that carried less than `Transfer floor` (an advanced setting, as a share of the total drive) are left out to keep the diagram readable. If that removes more than 1% of the drive, the node warns you, because the Sankey will show it as drive that stopped short.

`Transfers` is empty when the search met in the middle (see `Candidates` below); the node tells you when that happens.

## Settings

```coda-params
neuron.influence: direction, maxHops, minWeight, gain, denominator, includeFragments, frontierLimit, perQuery, seedWeighting
```

`Direction` sets which way the coins travel. "upstream (what influences them)" treats your neurons as the readout and asks what drives them. This is the usual question and works on every backend. "downstream (what they influence)" treats your neurons as the ones being stimulated, and needs `Denominator` set to one of the published totals.

`Max hops` is the number of rounds. More hops always reach more neurons and always raise scores. Each round costs one query, but the cost stops growing once the walk stops finding new neurons.

`Min synapses` ignores connections weaker than this. The default of 5 is the published implementation's own threshold. With the default `Denominator`, it is applied before each connection's share of the input is calculated, so raising it also makes every remaining connection a bigger share.

`Gain` is how much of the signal survives each extra synapse: at 0.5, a two-hop route counts for a quarter. This is the `lambda_max` of the published implementation, whose default is 0.99. We use 0.5 because at 0.99 the signal barely decays, so the score is dominated by very long chains that a bounded walk cannot see and that look much the same for every seed. If you want to reproduce a published figure, set `Gain` to 0.99, raise `Max hops` as far as you can afford, and check the shortfall the node reports.

`Denominator` decides how a connection's share of a neuron's input is calculated. The options differ in whether input below `Min synapses` is counted:

| Option | Divides by | Cost | Works for |
| --- | --- | --- | --- |
| "summed within the traversal" (default) | the inputs the walk has already fetched | free | upstream only |
| "published totals, reconstructed partners only" | the neuron's total input from other neurons | one query per hop | everything |
| "published totals, all synapses" | every synapse the neuron receives, fragments included | one query per hop | everything |

The default needs no extra queries and works on every backend, but it can only be calculated from the receiving end, so it can't go downstream and can't meet in the middle. The published totals need a dataset that publishes per-neuron synapse totals: currently the neuPrint datasets and the Demo Data, but not CAVE, CATMAID or precomputed sources. A dataset with a local edge table attached (via `Edge data` on the dataset node) has totals too, summed from that file's weights. An edge table can't tell neurons from fragments, so both published options give the same number there.

`Include fragments` decides whether unproofread bodies pass the signal on. It is off by default, because a large share of synaptic partners are fragments and following them makes the walk much larger. What counts as proofread is set on the Dataset node.

`Frontier limit` caps how many neurons carry their coins on to the next round, strongest first (0 means no limit). This is the main thing that keeps the cost in check. Whatever it drops is reported as a percentage of the signal.

`Per query neuron` gives you one row per query neuron and influencer instead of one row per influencer, with `queryId` and `queryType` saying which query neuron the row belongs to. These are the same numbers before they are summed: a [Group By](#core.groupBy) on `neuronId` summing `influence` gets you back to the normal result.

> [!WARNING] Per query neuron returns a plain table
> With `Per query neuron` on, `neuronId` appears once per query neuron, so the output is no longer
> a set of neurons. Wiring it straight into Skeletons or Adjacency will give an error until you
> put a Group By in between. It also can't meet in the middle: with `Candidates` wired, the node
> walks the full depth and then filters. The scores are the same, it just takes more queries.

`Seed weighting` (advanced) is "one each" by default: every query neuron gets its own coin, so a score is the sum over all of them, and seeding 50 neurons gives scores roughly ten times larger than seeding 5. "share of one" splits a single coin between them, which makes a score their mean and lets you compare runs over sets of different sizes. The two differ by exactly the number of query neurons, so switching doesn't change the order within a run.

## The Candidates input

`Candidates` is optional. Wire in a second set of neurons and the result is restricted to those, so you can ask "of these candidates, which influence my neurons most?".

This never changes a score, only which rows come back. It can make the query cheaper, though: with `Denominator` set to a published total, the node walks from both ends and meets in the middle, which fetches far fewer neurons. With the default denominator it can't do that, and the node tells you so before you run.

## Limitations

> [!WARNING] Downstream needs published totals
> Going downstream, each connection has to be divided by the receiving neuron's total input, which
> an outputs query doesn't return. Set `Denominator` to one of the published totals, or go
> upstream instead.

> [!WARNING] Drive into fragments is lost
> With `Include fragments` off, a fragment's share of a neuron's input still counts in the
> denominator; the fragment is just not followed any further. That share is not handed out to
> the remaining neurons. The node reports how much was lost this way.

> [!NOTE] No inhibition
> The published package can flip the sign of connections from inhibitory neurons. This node does
> not, so a strongly inhibitory input shows up as strongly influential. Read the score as "how
> much drive arrives from here", not "how much excitation".
