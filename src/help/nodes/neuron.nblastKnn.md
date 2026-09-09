[NBLAST](#neuron.nblast)'s sibling, asking a different question: for each query neuron, what are the best matches in the target set?

It is not a subset of the all-pairs matrix. It pre-selects a shortlist of candidates and scores only those with NBLAST, giving a table of matches — query neuron, candidate neighbour, rank, score.

> [!NOTE] The scores are exact; the candidate pre-selection is not
> At the default 200 candidates, recall of the true top 20 is ~99% while scoring ~0.16% of all
> possible pairs.

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

- **Neuron**: the query neuron
- **Neighbor**: a candidate neuron
- **Rank**: position in the top-k for this neuron (1 is best)
- **Score**: the NBLAST similarity — 0 to 1 when normalised; see [NBLAST](#neuron.nblast) for the scoring mechanics and the resample unit trap

So it plugs straight into Build Network, Filter or Sort like any other table.

> [!WARNING] Self-matching with and without Target
> With a `Target` wired, a neuron present in both sets scores itself at 1.00 and takes one of its k
> slots, so effectively k−1 real neighbours. Without a `Target`, every neuron is excluded from
> matching itself and all k slots are filled with other neighbours.

### Settings

```coda-params
neuron.nblastKnn: k, nCandidates
```

- **Symmetry**, **Resample**, **Normalise**, **Weight by alpha**: same semantics as [NBLAST](#neuron.nblast).
- **Tangent neighbours**: points used to fit the tangent vector at each skeleton point. 5 is the convention.
- **Warn above**: a threshold, not a cap. This is the node built for large sets, since its cost grows with **Candidates** rather than with the square of the population.
