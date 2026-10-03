## What NBLAST k-NN does

NBLAST k-NN finds the top matches for each query neuron. It uses the same scoring as [NBLAST](#neuron.nblast) but, instead of comparing every neuron against every other neuron, it first picks a shortlist of likely candidates for each neuron and then scores only those. The result is a table of matches rather than a matrix, which makes it much cheaper for large populations.

```coda-graph
caption: Get the top 10 matches for each neuron.
neuron.skeletons as skel1
neuron.skeletons as skel2
neuron.nblastKnn as nbl {k: 10}
out.table as tbl
skel1 -> nbl:query
skel2 -> nbl:target
nbl -> tbl
```

The scores themselves are exact NBLAST scores; only the shortlist is an approximation. At the default of 200 candidates, about 99% of the true top 20 matches are found while scoring only ~0.16% of all possible pairs.

## Output

The output table has one row per match:

| Column     | What it is                                              |
| ---------- | ------------------------------------------------------- |
| `queryId`  | the query neuron                                        |
| `targetId` | the matching neuron                                     |
| `rank`     | position among this neuron's matches (1 is best)        |
| `score`    | the NBLAST score (0 to 1 if `Normalise` is on)          |

If you set `Label by`, you also get `queryLabel` and `targetLabel` columns with a name for each side.

This is an ordinary table, so you can pass it on to e.g. [Build Network](#net.build) to get a similarity graph, or to [Embedding](#core.embed) to lay the neurons out in 2D.

A neuron can end up with fewer rows than `Matches per neuron` if fewer matches could be found for it.

> [!WARNING] Neurons matching themselves
> With `Target` wired, a neuron that is in both sets matches itself with a score of 1.00 and uses
> up one of its places, so you effectively get one match fewer. Without `Target`, neurons are never
> matched against themselves.

## Settings

```coda-params
neuron.nblastKnn: k, nCandidates
```

`Candidates` (under the advanced settings) is the size of the shortlist per neuron and trades accuracy for speed. For reference, the share of the true top 20 matches that is found is about 91% at 50 candidates, 97% at 100 and 99% at 200.

`Symmetry`, `Resample`, `Normalise` and `Weight by alpha` work just like in [NBLAST](#neuron.nblast). Note that `Symmetry` is applied before the top matches are picked. `Tangent neighbours` is the number of points used to fit the tangent vector at each skeleton point; 5 is the usual value.

`Warn above` only shows a warning; it doesn't stop you from running larger sets. Since the cost of this node grows with the number of candidates rather than with the square of the number of neurons, it is the one to use for large populations.
