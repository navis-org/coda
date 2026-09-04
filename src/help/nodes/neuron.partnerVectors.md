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

### Clustering two connectomes together

The whole point of the `Labels` port: neurons from two brains in one similarity matrix, so a MaleCNS neuron and a FlyWire neuron can land in the same cluster.

```coda-graph
caption: One branch per brain, joined at the feature axis. Each brain keeps its own Connectivity and its own Partner Vectors; what makes them comparable is that both read a label port of the same Match Cell Types.
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
qA -> stack:top
qB -> stack:bottom
stack -> sim
```

**One of these per brain, never one fed both.** The node reshapes an edge list relative to the neurons that were queried, and those are per-dataset. What joins the branches is the shared feature axis: `out:AVLP001` means the same thing in both tables because both label ports came from one [Match Cell Types](#compare.matchTypes).

**Tag the ids before stacking.** A `Qualify Ids` on each branch rewrites `neuronId` to `malecns:12345` / `flywire:12345`. Body ids are per-dataset, so without it [Stack Tables](#core.stack) silently merges neuron 12345 in one brain with neuron 12345 in the other, and [Similarity Matrix](#core.similarity) compares a chimera against itself. The tagged form is deliberately not a valid neuron id, so anything downstream that would query it refuses rather than fetching the wrong neuron — strip it again on the way to a viewer.

**`Weights` as fractions is doing real work here**, more than it does within one brain: two connectomes detect synapses differently, so raw counts are not on one scale. It does not rescue a `Min weight` set on the [Connectivity](#neuron.connectivity) cards, which is applied upstream and is not the same threshold in both.

[Cut Tree](#cluster.cut)'s mixed mode is the payoff at the far end — it reads each neuron's brain off the tagged id and returns the deepest clusters that still hold both.
