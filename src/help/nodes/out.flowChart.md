The picture a circuit paper prints: boxes in columns, arrows as thick as the connection is strong, the synapse count on them. Made for the dozen nodes a [Paths](#neuron.paths) result comes back with.

```coda-graph
caption: Routes from one population to another, drawn as the circuit they are.
neuron.inputIds as in1 {ids: "10001"}
neuron.inputIds as in2 {ids: "21312"}
neuron.paths as p
out.flowChart as flow
in1 -> p:sources
in2 -> p:targets
p -> flow
```

**This or the [Network Viewer](#out.network)** — they draw the same material and the choice is about size. A force layout has nothing to arrange below about twenty nodes and everything to arrange above a few hundred; a flow chart is the other way round. Above 120 boxes the card says `crowded`, and above 600 it declines and says so rather than drawing a grey field.

## Layers

```coda-params
out.flowChart: layerColumn, direction
```

Empty, **Layer by** puts each box one column to the right of the furthest-back thing that reaches it — longest path. That is the right reading for a Paths result, whose network is assembled from routes.

It is the wrong one for a network assembled from a ball rather than from routes, and wrong in a way that looks fine: a neuron one synapse from its seed lands five columns out because something else reaches it the long way round. Point **Layer by** at a column of the network's own instead, and each box sits where that column says. The caption says which rule ran.

> [!NOTE] Point it at a column that runs the way the signal does
> A layering column is a drawing position, not a measurement, and the two come apart wherever a
> network was assembled from a ball rather than from routes. A hop count towards a seed, for
> instance, runs *against* the signal — the seed is 0 and its influencers are 1, 2, 3 — so laid
> out by it the seed takes the first column and every connection draws as feedback. If the
> network you have carries only such a measurement, reverse it upstream first.

> [!NOTE] A column of measurements becomes adjacent columns
> Values of 0, 2 and 5 hops draw as three columns side by side, not six with gaps. A row with no
> value at all goes after every measured one rather than into the first column.

## Arrows

```coda-params
out.flowChart: routing, weightedArrows, edgeLabels, edgeLabelColumn
```

**Right angles** and **curves** route around whatever boxes lie between an arrow's two ends; **straight lines** joins the ends directly and may cross them. On a strictly two-layer fan the three look identical.

**Arrow labels** print the weight. *When there is room* draws them up to 40 boxes and drops them above that, with `labels off` in the caption. Point **Label from** at `weightNorm` on a normalised [Connectivity](#neuron.connectivity) or Paths result to label the arrows as fractions instead.

**A feedback arrow is dashed.** A layering makes every connection one of four things, and three of them are not a step forward: a recurrent connection runs back towards the sources, a connection inside one column has no length, and an autapse has one end. Drawn like the rest, a recurrent arrow points left through the boxes between its ends and reads as a data error. Nothing is hidden — the shape is what tells them apart, because colour is spent on the data.

## Boxes

```coda-params
out.flowChart: labelColumn, nodeColorMode, foldPerLayer
```

**Box label** is what each box says; empty uses the node's own id, which on a neuron-level network is an 18-digit root id. Point it at `type` or `instance` for something readable. Each box is sized to its own text, which is why this node lays itself out rather than taking a [Layout](#neuron.paths) wire: those positions are computed for same-sized discs.

**Colour** defaults to `role` — `source`, `target` or `via` on a Paths network, which is the one encoding a route picture wants. Anything else the network carries works: a `hops` ramp, a cell class, a [Cut Tree](#cluster.cut) cluster.

**Fold past** keeps that many boxes in each column, the busiest first, and folds the rest into one `+N others`. Clicking that box selects the nodes behind it.

> [!NOTE] Folding changes the drawing and not the output
> The Network port passes through whole, so adjusting the fold re-runs nothing. The cost is that
> the folded network is not available downstream — filter upstream if you want it.

## What leaves the node

- **Network** — the input, untouched. Every control here is presentational bar the selection, so restyling a figure never re-runs the query above it.
- **Selected** — the boxes you clicked, with the network's own node attributes beside them. Shift-click adds; clicking the background clears.

A node id is a neuron id on a neuron-level network and a cell type name on a type-level one, and `Selected` carries whichever it was under `neuronId`. A type-level selection therefore fails at the next query rather than quietly passing for neurons.

## In an exported document

Neither library draws this. The notebook lays the graph out with `multipartite_layout` and R Markdown with igraph's Sugiyama layout, both over Coda's own layering — so the columns are the card's. What differs is stated in the cell: networkx does no crossing minimisation and draws every edge straight, where igraph routes around the boxes in between; and a marker in either is a fixed size where Coda sizes each box to its label.
