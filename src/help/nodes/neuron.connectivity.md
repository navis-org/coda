The orientation is always **presynaptic → postsynaptic**, regardless of which `Direction` you
queried. Can be wired straight into Build Network with `Source: preId, Target: postId`.

### Direction and hops

**`direction: both`** at hops > 1 finds the undirected neighbourhood reached from either end at the same hop distance — not two independent directional cones stitched together. An edge found at an earlier hop keeps the direction label it was first assigned.

> [!WARNING]
> The traversal is iterative per-hop BFS: each hop queries the entire frontier as one request, unchunked. A large frontier can fail at the transport layer, and the frontier multiplies by the average partner count each hop — `Min weight` is the only brake.
>
> For large queries, consider providing a local edge table via the `Edge data` button on the dataset card.



## Include fragments

A synaptic partner is very often **not a neuron**. Segmentation produces far more fragments than it
does reconstructed cells, and a connectivity query finds every one of them. Measured on
`male-cns:v1.0`, five `LC4` neurons downstream at `Min weight` 1:

| far end | partners | connections | synapses |
| --- | --- | --- | --- |
| proofread neurons only (default) | 492 | 1,032 | 6,503 |
| fragments included | 4,252 | 4,889 | 11,898 |

So **88% of the partners are fragments**, carrying 45% of the synapses.

Left off, only proofread neurons come back — and **what counts as proofread is set on the Dataset
node**, by the same population checkboxes `Find Neurons` obeys. Every partner then has a row you can
look up, so the `Neuron Set` port is complete and `Skeletons`, `Meshes` and `Neuron Profile` all
work on it.

Tick it to get everything the query finds, small neuron fragments included. That is the whole truth
about where the synapses go, and it is what a total weight has to be measured against — it is the
population `Normalize`'s *all synapses* denominator counts.

**The neurons you asked about are never filtered out.** Only the far end is tested, so a body you
named by ID stays in the result whether or not the dataset calls it proofread.

> [!NOTE]
> Past one hop the setting also decides **what gets expanded**, so a two-hop result with fragments
> included is not the default one with rows added — it is a different traversal, and a far larger
> one. In the measurement above the second hop would start from 4,252 neurons rather than 492.

A workflow saved before this control existed included fragments and still does, so opening an old
graph does not change its numbers.

```coda-params
neuron.connectivity: includeFragments
```

## The Neuron Set port

Beside the edge list, the node emits `Neuron Set` — the neurons that edge list is **about**: the
ones you asked for, plus every partner it reached, one row each. It is called a *set* rather than
`Neurons` because the input port is already `Neurons`, and a node with the same name on both sides
means a pass-through everywhere else in Coda.

It exists because an edge list is the wrong *type* for the node that most obviously comes next.
`Adjacency` takes two neuron sets and answers the connections between them, which is how you close
a set of partners into the graph among themselves — and a table of `preId`/`postId` cannot be
plugged into it. Assembling one by hand meant renaming a column, stacking it onto the other,
deduplicating and feeding that through `Input IDs`: four nodes to say "the neurons I just found".

```coda-graph
caption: Pull the partners, then close the set into the graph among themselves
neuron.connectivity as conn { direction: both, hops: 1 }
neuron.adjacency as adj
out.heatmap as heat
conn:neuronSet -> adj:sources
conn:neuronSet -> adj:targets
adj -> heat
```

**The seeds are in it whether or not anything was wired to them.** Both ends of the edge list
already cover every seed that had a partner above `Min weight`; one that had none would vanish from
the set with nothing to say so. This node is the only place that holds both the neurons you asked
about and the ones it found, which is why the port lives here rather than in a downstream node.

`Neuron Set` decides how much each row carries:

- **minimal (IDs + types)** — free, and enough for anything keyed by id: `Adjacency`, `Skeletons`,
  `Meshes`, `Synapses`, `ROI Counts` all read the id column and nothing else.
- **full meta data** — looks every neuron up for the columns an edge list has no room for:
  `status`, `size`, `instance`. That is a second query over every neuron the result touched, and it
  runs whether or not the port is wired.

> [!NOTE]
> Under **full meta data** with `Include fragments` ticked, some neurons have no row to look up
> — a fragment is a real row in `Connections` and no row at all in the neuron table. They stay in
> the port with their ID and type and the rest of their columns empty, so the two outputs are
> always the same set of neurons. The node says how many that happened to.

```coda-params
neuron.connectivity: neuronRows
```

## Normalizing a weight

`Normalize` adds two columns: **`weightNorm`**, the connection as a fraction, and
**`weightTotal`**, the denominator it was divided by. The denominator is published beside the
fraction on purpose — the same `0.04` means two different things depending on the two controls
below, and with the number in the table you can check which without knowing how the node was set.

`Normalize by` chooses **which end of the connection** the denominator belongs to. These are
different questions, not two views of one number:

- **the target's total input** — how much of the receiving neuron's input this connection supplies.
- **the source's total output** — how much of the sending neuron's output goes down it.

`Denominator` chooses **which synapses are counted**, and the gap between the two is large:

| male-CNS body 10005 (AOTU019) | inputs | outputs |
| --- | --- | --- |
| all synapses | 31,981 | 23,423 |
| reconstructed partners only | 31,389 | **9,324** |

**Only about 40% of this neuron's outputs reach a named neuron**, against 98% of its inputs. That
asymmetry is reconstruction, not biology: outputs land on dendrites, which are hard to trace, so
most of them go to fragments the segmentation never promoted to a neuron. Inputs come from axons,
which are easy.

So:

- **all synapses** is every synapse the neuron makes, whether or not the thing on the other end
  was reconstructed. It is the number neuPrint publishes for that neuron, so the fractions of a
  full partner list sum to something at most 1 and the shortfall is what went to fragments.
- **reconstructed partners only** counts synapses onto partners the dataset calls neurons. This is
  the denominator to use when **comparing edge weights between connectomes proofread to different
  depths**, and it is what neuprint-python and the neuPrint website report. Note that a fraction
  can exceed 1 under it, legitimately: a connection to a fragment is in the numerator with no
  matching term below.

> [!NOTE]
> Coda's connectivity query matches a bare node at the far end, so a `Segment` below the
> segmentation threshold is still a row. The unsplit table therefore sums to the *all synapses*
> total, where the same query in neuprint-python sums to the *reconstructed partners* one.

A neuron the dataset publishes no total for — a fragment on the far end of an edge, under the
reconstructed-partners denominator — gets an **empty** `weightNorm` rather than a zero, and the
node says how many rows that happened to.

```coda-params
neuron.connectivity: normalize, normalizeBy, normalizeBasis
```

## Splitting and restricting by region

> [!WARNING] neuPrint-only
> The per-region breakdown lives on the connection itself in neuPrint. CAVE and CATMAID store
> region assignments per synapse, so answering this there means reading every synapse — the work
> their connection roll-ups exist to avoid. Both decline rather than approximate.

**`Split by region`** turns one row per connection into one row per connection per region, with a
`roi` column naming it. It is a *decomposition*: the parts are the connection taken apart, so the
partner set is unchanged and `Min weight` still applies to the whole connection. Build Network
downstream sums the parts back without you doing anything.

**`Regions`** restricts every weight to the named regions. A row's weight becomes the synapses
**inside** them rather than the connection's total, and a connection with none is dropped. The
difference is not small: body 10005's connections that *touch* `LAL(L)` carry 13,071 synapses, of
which 9,344 are actually in it.

**`Primary regions only`** is the vocabulary the other two draw on. Regions nest — a synapse in
`LAL(L)` is counted again in `LX(L)` and again in `CentralBrain` — so a split over the whole
published list counts the same synapse once per region containing it. On, only the set that tiles
the volume is offered. Leave it on unless you specifically want a super-region rollup.

How exact the split is was measured, over 20,000 sampled connections per dataset:

| dataset | synapses | in no primary region |
| --- | --- | --- |
| male-cns:v1.0 | 256,276 | 0 |
| manc:v1.2.1 | 385,947 | 7 |
| hemibrain:v1.2.1 | 274,844 | 1,104 (0.4%) |
| optic-lobe:v1.1 | 317,276 | 2,746 (0.9%) |

The primary set tiles male-CNS and MANC exactly. On hemibrain and optic-lobe a fraction of a
percent of synapses sit in no primary region at all and are **dropped** by a split over that set —
nothing here invents a `NotPrimary` bucket the way neuprint-python does, so this is a small
documented loss rather than a row claiming to be somewhere it is not.

```coda-params
neuron.connectivity: splitByRoi, rois, primaryRoisOnly
```

### Example: Edges to Build Network to Network Viewer

```coda-graph
caption: Connectivity wired into the pattern for visualization
neuron.connectivity as conn { direction: outputs, hops: 1 }
net.build as build
out.network as net
conn -> build
build -> net
```

### Settings

```coda-params
neuron.connectivity: direction, hops, minWeight
```
