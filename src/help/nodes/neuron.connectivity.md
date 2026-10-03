## What Connectivity does

Connectivity fetches the synaptic partners of the neurons you wire into it, one or more hops out. The result is an edge list in `Connections`: one row per connection with `preId`, `preType`, `postId`, `postType`, `weight` (the number of synapses), `hop` and `direction`.

Rows are always oriented presynaptic → postsynaptic, regardless of which `Direction` you queried. That means you can wire `Connections` straight into a [Build Network](#net.build) with `Source` set to `preId` and `Target` set to `postId`:

```coda-graph
caption: Fetch downstream partners and look at them as a network.
neuron.connectivity as conn { direction: outputs, hops: 1 }
net.build as build
out.network as net
conn -> build
build -> net
```

```coda-params
neuron.connectivity: direction, hops, minWeight
```

## Direction and hops

With `Hops` above 1, every partner found in one hop is expanded again in the next. With `Direction` set to "both (in + out)", the node walks the undirected neighbourhood: a neuron counts as one hop away if it connects to a seed in either direction. You do not get two separate upstream and downstream cones stitched together. An edge found at an earlier hop keeps the direction it was first found in.

> [!WARNING] Large queries can fail
> Each hop is a single request for every neuron in the current frontier, and the frontier grows
> by the average number of partners at every hop. `Min weight` is the only thing that keeps this
> in check. If you need large multi-hop queries, attach a local edge table to the dataset via
> `Edge data` on the dataset node.

## Include fragments

Most synaptic partners are not neurons. Segmentation produces far more fragments than reconstructed cells, and a connectivity query finds all of them. For example, five `LC4` neurons on `male-cns:v1.0`, downstream, at `Min weight` 1:

| Far end | Partners | Connections | Synapses |
| --- | --- | --- | --- |
| proofread neurons only (default) | 492 | 1,032 | 6,503 |
| fragments included | 4,252 | 4,889 | 11,898 |

In other words, 88% of the partners are fragments, and they account for 45% of the synapses.

With `Include fragments` off (the default), only proofread neurons come back. What counts as proofread is set by the population checkboxes on the Dataset node, the same ones [Find Neurons](#neuron.findNeurons) uses. Every partner then has a row in the neuron table, so the `Neuron Set` output is complete and nodes like [Skeletons](#neuron.skeletons), [Meshes](#neuron.meshes) and [Neuron Profile](#out.profile) work on it.

Turn it on to get everything the query finds. That is the full picture of where a neuron's synapses go, and it matches the "all synapses" denominator used by `Normalize` (see below).

Only the far end of each connection is filtered. The neurons you queried are always kept, even if the dataset does not consider them proofread.

> [!NOTE] Fragments change multi-hop queries
> With more than one hop, fragments are also expanded in the next hop. In the example above, the
> second hop would start from 4,252 bodies instead of 492, so expect a much larger (and slower)
> query.

> [!NOTE] Older workflows
> Workflows saved before `Include fragments` existed included fragments, and they still do when
> you open them.

```coda-params
neuron.connectivity: includeFragments
```

## The Neuron Set output

Besides the edge list, the node outputs `Neuron Set`: one row for each neuron in the result, i.e. the neurons you queried plus every partner that was found. Seeds without any partner above `Min weight` are included too.

This is useful because many nodes want a set of neurons rather than an edge list. For example, Adjacency takes two neuron sets and returns the connections between them, so you can fetch a neuron's partners and then get the connectivity among those partners:

```coda-graph
caption: Fetch the partners, then the connections among them.
neuron.connectivity as conn { direction: both, hops: 1 }
neuron.adjacency as adj
out.heatmap as heat
conn:neuronSet -> adj:sources
conn:neuronSet -> adj:targets
adj -> heat
```

The `Neuron Set` setting controls how much information each row carries:

- "minimal (IDs + types)" costs nothing and is all you need for nodes that only use the ID, such as Adjacency, [Skeletons](#neuron.skeletons), [Meshes](#neuron.meshes), Synapses and [ROI Counts](#neuron.roiCounts).
- "full meta data" looks up every neuron to add `status`, `size` and `instance`. This is a second query over every neuron in the result, and it runs whether or not the output is wired.

> [!NOTE] Fragments have no metadata
> Fragments do not have a row in the dataset's neuron table. With "full meta data" and
> `Include fragments` on, they stay in `Neuron Set` with their ID and type, and the other columns
> are empty. The node tells you how many.

```coda-params
neuron.connectivity: neuronRows
```

## Normalizing weights

`Normalize` adds two columns: `weightNorm`, the connection's weight as a fraction of a neuron's total synapses, and `weightTotal`, the total it was divided by. Which total that is depends on two settings, so always check `weightTotal` before comparing fractions.

`Normalize by` picks which end of the connection the total belongs to:

- "the target’s total input": what fraction of the receiving neuron's input this connection provides.
- "the source’s total output": what fraction of the sending neuron's output goes through this connection.

`Denominator` picks which synapses are counted, and this can make a big difference:

| male-CNS body 10005 (AOTU019) | Inputs | Outputs |
| --- | --- | --- |
| all synapses | 31,981 | 23,423 |
| reconstructed partners only | 31,389 | 9,324 |

Only about 40% of this neuron's output synapses go to a reconstructed neuron, compared with 98% of its inputs. This is a reconstruction artefact rather than biology: outputs land on dendrites, which are hard to trace, so many of them end up on fragments. Inputs come from axons, which are easier to reconstruct.

- "all synapses" counts every synapse the neuron makes, whether or not the partner was reconstructed. This is the total neuPrint publishes, so the fractions of a complete partner list add up to at most 1, and the shortfall is what went to fragments.
- "reconstructed partners only" counts only synapses onto neurons. This is what neuprint-python and the neuPrint website report, and it is the one to use when comparing edge weights between connectomes that were proofread to different extents. Note that with this setting a fraction can be larger than 1, because a connection to a fragment counts in the numerator but not in the denominator.

> [!NOTE] Totals differ from neuprint-python
> Coda's query also returns connections to `Segment`s below the segmentation threshold. Without a
> region split, the weights in the table therefore add up to the "all synapses" total, whereas
> the same query in neuprint-python adds up to the "reconstructed partners only" total.

If the dataset does not publish a total for a neuron, its `weightNorm` is left empty rather than set to zero, and the node tells you how many rows are affected.

If the dataset uses a local edge table (attached via `Edge data`), the totals are that file's weights summed per neuron. An edge table cannot tell neurons from fragments, so both `Denominator` options give the same number.

```coda-params
neuron.connectivity: normalize, normalizeBy, normalizeBasis
```

## Regions

> [!WARNING] neuPrint only
> The region settings only work on neuPrint datasets. CAVE and CATMAID store regions per synapse
> rather than per connection, and they refuse these settings rather than approximate.

There are three settings:

- `Split by region` turns one row per connection into one row per connection and region, with a `roi` column naming the region. The set of partners does not change, and `Min weight` still applies to the whole connection. A [Build Network](#net.build) downstream will sum the parts back together.
- `Regions` restricts every weight to the regions you pick: a row's weight becomes the number of synapses inside those regions, and connections with none there are dropped. For example, body 10005's connections that touch `LAL(L)` have 13,071 synapses in total, of which 9,344 are inside `LAL(L)`.
- `Primary regions only` decides which regions the other two settings offer. Regions are nested (a synapse in `LAL(L)` is also counted in `LX(L)` and in `CentralBrain`), so splitting by every published region counts the same synapse several times. Leave it on unless you specifically want the larger super-regions.

The primary regions do not cover every synapse in every dataset. Over 20,000 sampled connections per dataset:

| Dataset | Synapses | Not in any primary region |
| --- | --- | --- |
| male-cns:v1.0 | 256,276 | 0 |
| manc:v1.2.1 | 385,947 | 7 |
| hemibrain:v1.2.1 | 274,844 | 1,104 (0.4%) |
| optic-lobe:v1.1 | 317,276 | 2,746 (0.9%) |

Synapses outside every primary region are dropped from a split. neuprint-python puts them in a `NotPrimary` bucket instead; Coda does not.

```coda-params
neuron.connectivity: splitByRoi, rois, primaryRoisOnly
```

## Edge properties

On neuPrint, a connection carries more than its synapse count. Most datasets also publish `weightHP` and `weightHR`, and fish2 splits the count by compartment (`weightAxonDendrite`, `weightAxonAxon`, `weightDendriteAxon`, `weightDendriteDendrite`). Each property you pick under `Edge properties` is added as a column after `weight`.

The list comes from the dataset itself, so it differs between datasets and fills in shortly after the Dataset node has loaded. CAVE and CATMAID connections only have a synapse count, so the list stays empty there.

With `Split by region` or `Regions` on, each row carries that region's share of the property, and the shares add up to the connection's total. Properties that are not broken down by region (e.g. `weightHP`, marked "not by region" in the list) are left empty in that case.

`Min weight` always applies to `weight`. The same list is also offered by Adjacency's `Weight` and [Neuron Profile](#out.profile)'s `Count by`.

```coda-params
neuron.connectivity: edgeProperties
```
