## What Split Neurons does

Split Neurons takes a set of skeletons or meshes and splits it in two based on their attributes: neurons that match all filter rows come out of `Matching`, all others come out of `Rest`.

```coda-params
neuron.splitNeurons: filters
```

The filter rows work like the ones in [Find Neurons](#neuron.findNeurons): same controls, same operators, and rows are combined with `AND`. The difference is that they are applied to the attribute table that comes with the skeletons or meshes, so you can filter on whatever came back with the geometry, e.g. `type`, `status`, `size` or `cableLength`.

> [!TIP] Missing a column?
> If the column you want to filter on isn't offered, use `Carry fields` on the
> [Skeletons](#neuron.skeletons) or [Meshes](#neuron.meshes) node to bring it along from the
> neuron table.

You can think of this node as the opposite of Stack Neurons: Stack Neurons combines several sets and adds a column saying which input each neuron came from, Split Neurons separates them again. For example, a single row `source is hemibrain` takes a stacked scene apart again using the column Stack Neurons wrote.

## Why not just filter twice?

Every neuron comes out of exactly one of the two outputs, so the counts always add up to the input. Getting the same result with two separate filters is surprisingly easy to get wrong. Take these filter rows:

| Rows | `Matching` | `Rest` |
| --- | --- | --- |
| `type is LC4` and `side is left` | left LC4s | right LC4s, and every neuron that isn't an LC4 |

If you instead build two filters by hand, one keeping `type is LC4 AND side is left` and the other keeping `type is not LC4`, the right-side LC4s end up in neither.

This node is also useful once you only have the geometry, e.g. after stacking or after [Transform Neurons](#neuron.xform), where there is no neuron table left to filter.

## Good to know

> [!WARNING] No filters means nothing matches
> Without any filter rows, `Matching` is empty and all neurons come out of `Rest`.

> [!WARNING] Filtering on a missing column
> If a row names a column the neurons don't have, the node refuses to run. The row is marked on
> the card before you run anything.

> [!NOTE] Skeletons and meshes only
> Synapse point clouds are not accepted (their attribute rows are synapses rather than neurons).
> To filter a table of neurons, use [Filter Table](#core.filterTable).

Both outputs keep the input's units, template space and skeleton source, and each gets its own bounding box. You can therefore treat either of them like any other set of neurons: show it in a [3D View](#out.viewer3d), stack, mirror, [NBLAST](#neuron.nblast) or download it.

## Exporting

The R Markdown export supports this node, the Python notebook export does not. That is because navis has no equivalent: navis keeps attributes on the individual neuron objects (and the `type` column of `NeuronList.summary()` is the kind of neuron object, not the cell type), whereas nat keeps a data frame alongside its neurons.
