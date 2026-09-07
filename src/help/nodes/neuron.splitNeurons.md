Take a collection of skeletons or meshes and get **both halves** of a filter: the neurons matching every filter row on `Matching`, the rest on `Rest`.

```coda-params
neuron.splitNeurons: filters
```

It is Stack Neurons run backwards. That node puts several collections end to end and writes a column saying which input each neuron came from; this one asks the attribute table a question and hands back both answers — so one row, `source is hemibrain`, takes a stacked scene apart again on the very column the stack wrote.

The filters are [Find Neurons](#neuron.findNeurons)' rows — same three controls, same operators, combined with `AND` — but read against the attribute table the collection carries rather than a dataset's neuron schema. So the fields are what came back with the geometry: `type`, `status`, `size`, `cableLength`, and whatever else was carried along.

**If the field you want is not offered, carry it.** [Skeletons](#neuron.skeletons) and [Meshes](#neuron.meshes) have a `Carry fields` control that brings columns of their incoming neuron table onto the geometry, matched by `neuronId` — a `cellBodyFiber`, a hemisphere, an annotation, a column a Relabel wrote. That is the intended route to everything the fetch itself does not return.

## Why not filter upstream twice

Because the second filter is usually wrong, and often there is nothing left to filter.

| rows | `Matching` | `Rest` |
| --- | --- | --- |
| `type is LC4` **and** `side is left` | left LC4s | right LC4s, **and every non-LC4** |

A hand-built pair — one arm keeping `type is LC4 AND side is left`, another keeping `type is not LC4` — loses the right-side LC4s from both. Here the two ports come off one pass, so every neuron leaves on exactly one of them and the counts always sum to the input's. And once the geometry is in hand — after a stack, or after [Transform Neurons](#neuron.xform) — there is no table upstream to filter at all.

> [!WARNING] With no filters, nothing matches
> `Matching` is empty and the whole collection leaves on `Rest`. An empty set of rows is a predicate that has matched nothing, not a pass-through — so a half-built card visibly does nothing rather than looking like a finished one whose filters happen to keep every neuron.

> [!WARNING] A row naming a column the neurons do not carry refuses the run
> Rather than splitting on the rows that do resolve, which would still hand back a partition — of a different question, with neurons on the wrong side of it. The card marks the row before you run anything.

> [!WARNING] Skeletons and meshes only
> A synapse cloud is refused although Stack Neurons accepts one: its attribute rows are connectors rather than neurons, so splitting it would divide synapses under a name about neurons. A table of neurons is refused too — [Filter Table](#core.filterTable) keeps the rows matching a condition.

Both halves carry the collection's units, template space and skeleton provenance, and each recomputes its own bounding box — so either port frames correctly in a [3D View](#out.viewer3d) and can be stacked, mirrored, NBLASTed or downloaded like any other collection.

The notebook export refuses this node and the R Markdown one emits it, which is the libraries' asymmetry rather than a gap: nat keeps a data frame beside its neurons, where navis keeps attributes on the neuron objects and `NeuronList.summary()`'s `type` column is the neuron class rather than the cell type.
