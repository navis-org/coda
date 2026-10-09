## What the Network Viewer does

The Network Viewer draws a network as an interactive node-link diagram: neurons (or cell types) as discs, connections as links. Colour, size, shape and labels can all be driven by columns, and whatever you click in the viewer comes out of the `Selected` port.

The network itself is usually made by [Build Network](#net.build), which turns an edge table into nodes and links. It sums the weights of rows that connect the same pair, adds in/out degree and in/out weight to each node, and can join extra columns onto the nodes from a second `Node attrs` table. The edge table can be a [Connectivity](#neuron.connectivity) result or any table with a source and a target column:

```coda-graph
caption: An edge list from Connectivity, turned into a network and drawn.
neuron.connectivity as conn
net.build as build { source: preId, target: postId, weight: weight }
out.network as net
conn -> build
build -> net
```

Both the nodes and the links are ordinary attribute tables, one row per node or link, so colouring nodes by cell type works with the same column picker as anywhere else. Keeping the build and the drawing in two nodes means you can restyle the picture without re-running anything that reads the network.

The `Network` output passes the graph through (apart from the filters below), and `Selected` carries whatever you clicked.

## Filters

Most settings on this node only change the picture. The three on the `Filter` tab are different: they change the network that leaves the node, so everything wired downstream has to re-run when you change them.

```coda-params
out.network: minLinkWeight, topNodes, hideIsolated
```

They are applied in this order:

1. `Min link weight` drops links below the threshold.
2. `Top nodes` keeps the N nodes with the most attached weight, counted over the links that survived step 1.
3. `Hide isolated` drops nodes that are left without links, including those stranded by the first two steps.

Afterwards `degreeIn`, `degreeOut`, `weightIn` and `weightOut` are recomputed for the remaining nodes, so if you size nodes by degree the sizes match what you see.

## Choosing a layout

| Layout                     | Behaviour                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `force-directed (prefuse)` | lays out each disconnected piece separately and packs the results; the default          |
| `force-directed`           | simulated repulsion and attraction, settling live in a background worker               |
| `circular`                 | a single ring; always gives the same result                                            |
| `layered (feed-forward)`   | layers by longest path or by a column you choose; left to right or top to bottom       |
| `spectral`                 | uses eigenvectors of the graph Laplacian, so structurally similar nodes end up close   |
| `grouped by column`        | one ring per group, members arranged inside it; always gives the same result           |
| `from columns`             | reads each node's position from two columns you pick                                   |

```coda-params
out.network: layout
```

A few details:

- `force-directed` is the only layout that keeps moving after it first appears. The others arrive finished.
- `Weight pull` sets how strongly a link's weight pulls its two ends together. Even at 0, weight still affects the spacing because a node's mass is its weighted degree.
- `spectral` ignores weights (synapse counts span orders of magnitude, and a few strong links would dominate). It also won't lay out fewer than three nodes or a graph without links.
- If something is wired into the `Layout` input (e.g. positions from [Paths](#neuron.paths)), those positions are used instead of the `Layout` setting, and the caption says so.

Layouts only affect the drawing: positions are not saved, and changing the layout doesn't invalidate anything downstream.

### Networks with many disconnected pieces

If your network consists of many small, disconnected clusters (e.g. a cell-type correspondence graph or a thresholded connectome), `force-directed` will draw a uniform blob. Letting it run longer makes this worse: nothing holds two unconnected pieces apart, so the simulation's gravity pulls them all into the same spot.

`force-directed (prefuse)` gets around this by laying out each connected piece on its own and then packing the results side by side. It is the same layout Cytoscape calls "Prefuse Force Directed". On a 36,000-node correspondence graph in 12,000 pieces it gave a readable picture in half a second, where the ordinary force layout never produced a usable one.

Some related settings:

- `Components` set to "all at once" switches the packing off.
- `Link length` sets the scale for everything else in the layout.
- `Iterations` makes little difference past about 25, because this layout cools down on its own.

## Shapes

`Shape` works like `Colour`: pick "by category" and a column, and each value gets its own mark. If you point `Shape` and `Colour` at the same column, the figure stays readable in black and white and for colour-blind readers.

```coda-params
out.network: nodeShapeMode
```

There are six marks: circle, square, triangle, diamond, cross and plus. Values beyond the six most common are all drawn as a dash. Unlike colours, shapes are not reused, since a second set of circles would suggest that two categories are the same. If you have more than six categories, colour is the better channel.

To assign a particular mark to a value, use the menu on its legend entry. A mark assigned this way takes precedence over the ranking, and two values can share a mark.

## Colours and palettes

When colouring by category, colours are reused once the palette runs out: the twelfth cell type gets a colour again rather than a grey catch-all. Two categories a palette-length apart then share a colour, and the caption shows `colours repeat` when that happens.

Nodes and links each have their own palette, on their own tabs:

```coda-params
out.network: nodePalette, edgePalette
```

| Palette     | Colours | When to use                                                                 |
| ----------- | ------- | --------------------------------------------------------------------------- |
| `Coda`      | 8       | the default, and the only one tuned for both light and dark backgrounds     |
| `Okabe–Ito` | 8       | figures that need to work for colour-blind readers                           |
| `Tableau`   | 10      | matplotlib's `tab10`, familiar from most plotting libraries                  |
| `Paired`    | 12      | ColorBrewer's `Paired`, saturated half first                                  |
| `tab20`     | 20      | the most categories before colours repeat; its first ten are `Tableau`       |

The last four are published palettes used as-is, so the pale colours in `Paired` and `tab20` are hard to see on a light background.

The legend lists up to twelve entries and then shows `+N more`. Everything beyond that is still drawn.

### Colouring nodes by a number

Under **Nodes ▸ Colour**, "by value" maps a numeric column onto a colour ramp. You then get four more controls:

- `ramp`: Coda blue or one of matplotlib's ramps. The ones marked `centred` are diverging.
- `min` and `max`: the values at either end. Leave them empty to follow the data. For a centred ramp both arms are the same length, so `max` is the distance from the centre to either end.
- `centre`: the midpoint of a centred ramp.
- `log`: put the ramp on a log scale.

The legend shows `values clipped` if some nodes fall outside the ends, and `log colour` when the log scale is on.

Links can't be coloured by value, because the pale end of a ramp is invisible on a thin line.

### Colouring by component or by endpoint

Two colour modes don't come from a column:

- **Nodes ▸ Colour ▸ "by connected component"** gives each connected component its own colour. This is useful because a force layout may squash two components into one blob or spread one across the canvas. Components are numbered by size (`1` is the largest) and ignore link direction. This is the same grouping that `Select connected component` uses.
- **Links ▸ Colour ▸ "by upstream node" / "by downstream node"** gives each link the colour of the node at one of its ends. With nodes coloured by cell type, colouring links by their upstream node shows where each type's output goes.

```coda-params
out.network: nodeColorMode, edgeColorMode
```

The link modes don't add a legend of their own, since they reuse the node colours.

> [!NOTE] Not the same as colouring by `source`
> You could instead colour links "by category" using the `source` column. That ranks the palette
> by how many links each source has, so the link colours won't match the node colours. Use "by
> upstream node" if you want them to match.

## Arranging nodes by hand

In the expanded view you can drag nodes around and they stay where you drop them. Dragging a selected node moves the whole selection along with it. Dragging an unselected node moves only that node, and a drag never counts as a click.

- **⤢** zooms to fit everything, including nodes you dragged away.
- **↻** discards your manual placement and runs the layout again from scratch.

> [!NOTE] Manual positions are not saved
> Your arrangement survives closing and reopening the viewer during a session, and the card, the
> inspector and the expanded view share it. It is not saved into the file or a share link, so a
> saved workflow is laid out afresh when you open it again. The caption shows `moved by hand`
> while any nodes have been placed manually.

With `force-directed`, nodes you drop keep moving while the layout is still settling. Pause it with ❙❙ (or wait for it to finish) before arranging things by hand.

## Selecting nodes

Clicking nodes selects them. The selection is stored in the `Selected` setting, so it is saved with the workflow and can be undone, and it feeds the `Selected` output as a table of neurons.

### The right-click menu

Right-clicking in the expanded view opens a menu. If you right-click a node inside the current selection, the command acts on the whole selection; a node outside it, and the command acts on that node alone (without selecting it). Right-clicking a link acts on both of its ends.

| Command                      | What you get                                                    |
| ---------------------------- | --------------------------------------------------------------- |
| `Select connected`           | the starting nodes plus everything one link away, in either direction |
| `Select downstream`          | the starting nodes plus their targets (directed networks only)  |
| `Select upstream`            | the starting nodes plus their sources (directed networks only)  |
| `Select connected component` | everything reachable along links, ignoring direction            |
| `Copy id`                    | the ids, one per line, copied to the clipboard                  |

Each command replaces the selection with a larger one that still contains the starting nodes. Running `Select connected` again therefore reaches one hop further out.

`Select downstream` and `Select upstream` aren't offered for undirected networks, where source and target are in arbitrary order.

Right-clicking empty canvas gives you `Select all`, `Clear selection`, `Copy all ids` and `Fit to view`.

> [!WARNING] Selecting cell types gives empty neuron ids
> A network node's id is a neuron id in a neuron-level network but a type name once nodes are
> grouped by type. `Selected` fills its `neuronId` column from that id, so selecting types gives
> rows with an empty `neuronId`. Nodes downstream that need neuron ids will then report an error.
