## What Neuron Profile does

Neuron Profile shows a summary of one neuron at a time: who it is, its up- and downstream partners grouped by type, where its synapses are, its predicted transmitter and its shape in 3D. Use the pager on the card to step through the neurons in the incoming table.

```coda-graph
caption: Search in Explore Dataset and get a per-neuron summary.
neuron.explore as exp
out.profile as prof
out.neuroglancer as ngl
exp:selected -> ngl
exp:selected -> prof
```

How much the card can show depends on the dataset. neuPrint datasets give the fullest picture because they publish a lot of precomputed information. For CAVE and CATMAID datasets some panels stay empty.

## Thresholds

`Min synapses` drops partner connections below that number from the lists and counts, and `Rows per list` sets how many entries each list shows. Both take effect immediately without re-running anything.

```coda-params
out.profile: minWeight, topN
```

## Counting by an edge property

By default the partner lists count synapses. `Count by` lets you count a property that the dataset publishes for each connection instead. On fish2, for example, "weightAxonDendrite" ranks partners by the number of synapses that go from axon to dendrite. `Min synapses` then applies to whatever you chose here.

```coda-params
out.profile: countBy
```

## Profiling groups of neurons

With `Group by` empty, the pager steps through individual neurons. Pick a column (e.g. `type`, `hemilineage`, `class`, a cluster id from [Cut Tree](#cluster.cut) or a shared label from [Match Cell Types](#compare.matchTypes)) and it steps through groups instead. Each panel then shows the mean across the group's members, with the standard deviation next to it.

```coda-params
out.profile: groupBy
```

A few things to keep in mind when reading the numbers for a group:

- Members without any connection to a given partner type count as zero. Each bar's tooltip tells you how many members actually contributed, so you can tell "4 synapses on average across all thirty" from "4 on average, from two of them".
- A group with a single member shows its value with no `±` and no whisker.
- In the ranked lists, the bar shows the mean and the line through it shows ±1 standard deviation (clamped at zero). Hover a row to see the numbers. The totals at the top of the Connectivity panel are printed in full as `mean ± sd`.
- Transmitter calls are not averaged. Instead, the panel lists every call within the group with a count, e.g. 28 cholinergic and 2 GABAergic. The probability bars and the confidence are means, taken over the members that have a prediction.

> [!NOTE] Large groups
> Groups with more than fifty neurons are not loaded automatically. The card shows the group's
> name and size and lets you load it with a click.

## Pinning

The `Current` output emits whatever you have pinned on the card. When grouping, pinning a group sends all of its neurons, so a downstream [Skeletons](#neuron.skeletons) or [Connectivity](#neuron.connectivity) node receives the whole type. Paging through neurons does not change any output; pinning does, and downstream nodes will need to re-run.
