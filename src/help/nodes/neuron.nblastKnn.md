This is [NBLAST](#neuron.nblast)'s sibling, asking a different question: for each query neuron, what are the best matches in the target set?

It's not simply a subset of the all-pairs matrix but pre-selects a shortlist candidates and then scores only those with NBLAST. The result is a table of matches, each row containing a query neuron, a candidate neighbour, its rank and score.

> [!NOTE]
> While the returned NBLAST scores are exact, the candidate pre-selection is approximate. At the default 200 candidates, recall of the true top 20 is ~99%, while only scoring ~0.16% of all possible pairs.

```coda-graph
caption: Get the top 10 matches
neuron.skeletons as skel1
neuron.skeletons as skel2
neuron.nblastKnn as nbl {k: 10}
out.table as tbl
skel1 -> nbl:query
skel2 -> nbl:target
nbl -> tbl
```

### Output format

Each row contains:
- **Neuron**: the query neuron
- **Neighbor**: a candidate neuron
- **Rank**: position in the top-k for this neuron (1 is best)
- **Score**: the NBLAST similarity (0 to 1 for normalized; see [NBLAST](#neuron.nblast) for scoring mechanics and the resample unit trap)

So it plugs straight into Build Network, Filter, or Sort like any other table.

> [!WARNING] Self-matching with and without Target
> With a `Target` wired, a neuron present in both sets scores itself at 1.00 and takes one of its k slots (so effectively k−1 real neighbours). Without a `Target` wired, every neuron is excluded from matching itself, and all k slots are filled with other neighbours.

### Settings

```coda-params
neuron.nblastKnn: k, nCandidates
```

- **Symmetry**, **Resample**, **Normalise**, **Weight by alpha**: same semantics as [NBLAST](#neuron.nblast); read that node's help for details.
- **Tangent neighbours**: points used to fit the tangent vector at each skeleton point. 5 is the convention.
- **Warn above**: says so before scoring either side above this many, and then scores. A threshold, not a cap — this is the node built for large sets, since its cost grows with **Candidates** rather than with the square of the population.
