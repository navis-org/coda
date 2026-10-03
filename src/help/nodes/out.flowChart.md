The Flow Chart draws a small network as a circuit diagram of the kind you find in papers: labelled boxes arranged in columns, with arrows whose thickness reflects the strength of the connection and the synapse count printed on them. It is made for the dozen or so nodes that a [Paths](#neuron.paths) result typically contains.

```coda-graph
caption: Paths from one neuron to another, drawn as a circuit diagram.
neuron.inputIds as in1 {ids: "10001"}
neuron.inputIds as in2 {ids: "21312"}
neuron.paths as p
out.flowChart as flow
in1 -> p:sources
in2 -> p:targets
p -> flow
```

## Flow Chart or Network Viewer?

The [Network Viewer](#out.network) takes the same input, and which one to use mostly depends on size. Below about twenty nodes a force layout has little to work with and the flow chart gives the clearer picture; above a few hundred it is the other way round. With more than 120 boxes the card shows `crowded`, and above 600 boxes it doesn't draw at all. Filter upstream, fold the columns (see `Fold past` below) or switch to the Network Viewer in that case.

## Layers

```coda-params
out.flowChart: layerColumn, direction
```

By default (`Layer by` left empty) each box is placed one column to the right of the furthest-back box that connects to it, i.e. layers follow the longest path. That works well for a Paths result, which is built from routes.

For other networks, e.g. everything within a few hops of a seed neuron, longest-path layering can be misleading: a neuron directly downstream of the seed may end up five columns out because something else also reaches it via a longer route. In that case, point `Layer by` at a column in your network and each box is placed where that column says. The caption tells you which rule was used.

> [!NOTE] The layer column should follow the direction of the signal
> Make sure the column increases in the direction of the signal. A hop count *towards* a seed runs
> the other way: the seed is 0 and its upstream partners are 1, 2, 3. Laid out by that, the seed ends up in
> the first column and every connection is drawn as feedback. If that's what you have, reverse
> the values upstream first.

> [!NOTE] Gaps are closed up
> Values of 0, 2 and 5 are drawn as three adjacent columns, not six columns with gaps. Rows with no
> value go after all the others rather than into the first column.

## Arrows

```coda-params
out.flowChart: routing, weightedArrows, edgeLabels, edgeLabelColumn
```

- `Arrows`: "right angles" and "curves" route around any boxes between the two ends of an arrow; "straight lines" connects the ends directly and may cross other boxes. If the chart has only two layers, all three look the same.
- `Thickness by weight`: turn this off to draw all arrows the same width, e.g. if the weights in your network aren't comparable.
- `Arrow labels` prints the weight on each arrow. "when there is room" draws them for up to 40 boxes and switches them off above that, in which case the caption shows `labels off`.
- `Label from` picks a different edge column to print. For example, use `weightNorm` on a normalised [Connectivity](#neuron.connectivity) or Paths result to show fractions instead of synapse counts.

### Feedback and other connections

Each connection is one of four kinds, and they are told apart by the shape of the arrow (colour is left for your data):

| Connection                           | Drawn as                     |
| ------------------------------------ | ---------------------------- |
| forward, to a later column           | a normal arrow               |
| back, to an earlier column           | dashed                       |
| between two boxes in the same column | bulging out to the side      |
| from a neuron onto itself (autapse)  | a loop                       |

Nothing is hidden. Feedback arrows are dashed so that an arrow pointing backwards through the chart doesn't look like an error.

## Boxes

```coda-params
out.flowChart: labelColumn, nodeColorMode, foldPerLayer
```

`Box label` sets the text in each box. Left empty, it shows the node id, which in a neuron-level network is a long root id; point it at `type` or `instance` for something readable. Each box is sized to fit its label.

Boxes are a single colour by default. Switch `Box colour` to "by category" and the picker starts on `role`, which in a Paths network is `source`, `target` or `via`. Any other column works too, e.g. `hops`, a cell class or the cluster from a [Cut Tree](#cluster.cut).

`Fold past` keeps that many boxes per column (the busiest first) and folds the rest into a single `+N others` box. Clicking that box selects all the nodes behind it.

> [!NOTE] Folding only changes the drawing
> The `Network` output always passes on the whole network, so changing `Fold past` doesn't re-run
> anything. It also means the folded version isn't available downstream; if you need a smaller
> network, filter it upstream.

The Flow Chart lays itself out and has no `Layout` input: positions computed by Paths assume equal-sized discs and don't fit boxes sized to their labels.

## Outputs

- `Network` is the input, passed through unchanged. Apart from the selection, all settings on this node only affect the drawing, so restyling never re-runs anything upstream or downstream.
- `Selected` contains the boxes you clicked, along with their node attributes. Shift-click adds to the selection; clicking the background clears it.

In a neuron-level network the node ids are neuron ids; in a type-level network they are cell type names. `Selected` puts either into its `neuronId` column, so a selection of cell types will fail at the next query that expects neurons.

## In exported notebooks

Neither Python nor R has a direct equivalent of this chart. The Python notebook lays the graph out with networkx's `multipartite_layout` and the R Markdown with igraph's Sugiyama layout, both using Coda's layers, so the columns match the card. The exported cell notes the differences: networkx doesn't reduce edge crossings and draws every edge straight, whereas igraph routes edges around the boxes in between; and in both, markers have a fixed size, where Coda sizes each box to its label.
