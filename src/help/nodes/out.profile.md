```coda-graph
caption: Search in Explore Dataset and get a per-neuron summary.
neuron.explore as exp
out.profile as prof
out.neuroglancer as ngl
exp:selected -> ngl
exp:selected -> prof
```

What this node can show depends on the dataset. Richest for neuPrint datasets because of the precomputed information it provides.

For CAVE and CATMAID datasets, some of the panels will remain empty.

```coda-params
caption: Threshold controls—instant filtering.
out.profile: minWeight, topN
```

## One cell, or one cell type

Leave **Group by** empty and the pager walks neurons, one row at a time. Point it at a column — `type`, `hemilineage`, `class`, a cluster id from Cut Tree, a shared label from Match Cell Types — and it walks *groups* instead: every tile then shows a mean across the members of the group with a sample standard deviation beside it.

A column rather than a `Show types` switch because datasets do not agree on what the column is called, and because the interesting groupings are not always cell types.

```coda-params
caption: Empty pages neurons; a column pages groups.
out.profile: groupBy
```

Three things about the numbers are worth knowing, because each is a place where a plausible wrong answer is easy to produce:

- **The denominator is the whole group.** A member with no connection to a partner type counts as a zero, not as a gap — it was measured, and the measurement is zero. Averaging over only the members that connect would report a much larger number under the type's name. Each bar's tooltip says how many members actually contributed, which is what separates "4 synapses on average, all thirty of them" from "4 on average, two of them".
- **A group of one has no spread.** It shows its value and no `±`, and no whisker. The spread of a single measurement is unknown rather than zero.
- **In the ranked lists the number is the mean and the spread is the line through the bar** — ±1 sd, clamped at zero. Hover a row for the figures. The headline totals in the Connectivity tile print `mean ± sd` in full, because they have a line each.
- **A transmitter call is not averaged.** The tile lists every call the group makes with a count — a type that is 28 cholinergic and 2 GABAergic is interesting exactly where a single answer would round it away. The probability bars and the confidence *are* means, and both average over the members that publish a value rather than over the whole group: a neuron the model declined to score has not been measured, so counting it as zero would make a type look less confident the more of it went unscored.

Pinning a group sends **all** of its neurons out of the Current port, so a downstream Skeletons or Connectivity node receives the whole type.

Past fifty neurons a group is not fetched until you ask. Nothing is refused — the card names the group and its size and offers to load it — but paging through large types would otherwise ask the connectome a very large question between two presses of ›.
