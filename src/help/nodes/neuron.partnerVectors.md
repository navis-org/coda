Partner Vectors turns a [Connectivity](#neuron.connectivity) edge list into one feature vector per neuron, describing who that neuron connects to. The output is in the long form that [Similarity Matrix](#core.similarity) expects (one row per neuron and feature), so you don't need a [Group By](#core.groupBy) or [Pivot](#core.pivot) in between:

```coda-graph
caption: Compare neurons by their connectivity, then cluster them.
neuron.connectivity as conn
neuron.partnerVectors as pv
core.similarity as sim
cluster.linkage as link
conn -> pv:in
pv -> sim
sim -> link
```

The output has the columns `neuronId`, `direction` (`in`/`out`), `partner`, `feature`, `weight` and `cnFrac`.

Upstream and downstream partners are kept as separate features (e.g. `in:DA1_lPN` and `out:DA1_lPN`). That way, a neuron that *receives* input from a cell type doesn't look similar to one that *projects* to it.

## Settings

```coda-params
neuron.partnerVectors: partnerBy, untyped, weighting
```

For `Partners by`, "Cell type" is usually what you want. Comparing by "Neuron id" only finds neurons that share the exact same partner neurons, which across hemispheres or animals will be none at all.

`Untyped partners` controls what happens to partners that have no cell type. By default, each one becomes a feature of its own, named by its id. Pooling them all into a single `untyped` bucket would make unrelated neurons look similar. Choosing "Drop the connection" instead avoids that too, but then the vectors no longer account for all of a neuron's synapses.

With `Weights` set to "Fraction of the query's total", fractions are computed separately for each direction. A neuron with far more input than output therefore still has both halves of its vector count. Cosine similarity already ignores overall magnitude, so this changes the balance between the two directions rather than the overall scale.

> [!NOTE] Connectivity over several hops
> Without the optional `Neurons` input, the node works out which end of each edge was the queried
> neuron from the `direction` column. That only works for the first hop, so edges further out are
> left out (the node tells you how many). To use every hop, wire the neurons you queried into
> `Neurons`.

## Comparing across brains

To compare neurons from different datasets, wire `Labels` from [Match Cell Types](#compare.matchTypes). Partners are then named by their shared label, and any partner that isn't mapped is dropped. `Partners by` and `Untyped partners` no longer apply in that case.

> [!WARNING] Check `cnFrac`
> `cnFrac` is the fraction of each neuron's connectivity that survived the mapping. If it is below
> about half, the vector only describes the minority of the neuron that happened to be mappable,
> and so does any similarity computed from it. The node warns you about this but still runs.

### Clustering two connectomes together

```coda-graph
caption: One branch per dataset, joined by the shared labels from a single Match Cell Types.
neuron.connectivity as connA "Connectivity · MaleCNS"
neuron.connectivity as connB "Connectivity · FlyWire"
compare.matchTypes as match
neuron.partnerVectors as pvA { weighting: fraction }
neuron.partnerVectors as pvB { weighting: fraction }
core.qualifyIds as qA { prefix: malecns }
core.qualifyIds as qB { prefix: flywire }
core.stack as stack
core.similarity as sim { metric: cosine }
connA -> pvA:in
match:labels1 -> pvA:labels
connB -> pvB:in
match:labels2 -> pvB:labels
pvA -> qA
pvB -> qB
qA -> stack:in1
qB -> stack:in2
stack -> sim
```

A few things to note about this setup:

- **Use one Partner Vectors node per dataset.** Don't feed both edge lists into the same node: the vectors are built relative to the neurons that were queried, and those are specific to each dataset. What makes the two branches comparable is that both `Labels` inputs come from the same [Match Cell Types](#compare.matchTypes), so a feature like `out:AVLP001` means the same thing in both tables.
- **Tag the ids before stacking.** A `Qualify Ids` on each branch rewrites `neuronId` to e.g. `malecns:12345` or `flywire:12345`. Body ids are only unique within a dataset, so without this [Stack Tables](#core.stack) would silently treat neuron 12345 in one brain and neuron 12345 in the other as the same neuron. The tagged ids are not valid neuron ids, so nodes that would query them will refuse instead of fetching the wrong neuron. Strip the tags again before passing the ids to a viewer.
- **Use fractions as `Weights`.** Different connectomes detect synapses differently, so raw counts are not directly comparable. Note that this does not fix a `Min weight` set on the [Connectivity](#neuron.connectivity) nodes: that threshold is applied upstream and does not mean the same thing in both datasets.

At the end of the chain, [Cut Tree](#cluster.cut) has a mode for exactly this situation: it reads each neuron's dataset from the tagged id and returns the smallest clusters that still contain neurons from both datasets.
