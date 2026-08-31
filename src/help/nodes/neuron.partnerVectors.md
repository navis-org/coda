Reshapes a [Connectivity](#neuron.connectivity) edge list into the long form [Similarity Matrix](#core.similarity) needs: one row per neuron and feature.

```coda-graph
caption: No Group By and no Pivot in between — the long table already is the feature matrix.
neuron.connectivity as conn
neuron.partnerVectors as pv
core.similarity as sim
cluster.linkage as link
conn -> pv:in
pv -> sim
sim -> link
```

Output columns: `neuronId`, `partner`, `feature`, `weight`, `direction` (`in`/`out`), `cnFrac`.

**Upstream and downstream are kept apart as separate features**, so a neuron that _receives_ from a type is not counted as alike to one that _projects_ to it.

## Settings

```coda-params
neuron.partnerVectors: partnerBy, untyped, weighting
```

`Partners by` cell type is the usual choice — comparing by neuron id only finds neurons sharing literal partners, which across hemispheres or animals is nothing.

> [!WARNING] Untyped partners keep their own ids rather than pooling
> A shared `untyped` bucket makes strangers look similar. Setting `Untyped partners` to drop instead means the vectors no longer account for all of a neuron's synapses.

`Weights` as fractions are computed **per direction**, so a neuron with far more input than output still has both halves of its vector count. Cosine already ignores overall magnitude, so this changes the balance between the two directions, not the scale.

## Comparing across brains

Wire `Labels` from [Match Cell Types](#compare.matchTypes). Partners are then named by their shared label, and **anything unmapped is dropped**.

> [!WARNING] Read `cnFrac`
> It is the share of each neuron's connectivity that survived the mapping. Below about half, the vector describes the minority of the neuron that happened to be mappable, and every distance computed from it is about that minority. The node warns, it does not refuse.
