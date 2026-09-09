## Two nodes for one job

1. **`Build Network`** turns an edge table into nodes and links, deriving the roll-ups a node-link drawing needs — in/out degree, in/out weight.
2. **`Network Viewer`** draws the result. Both halves are ordinary Coda attribute tables, one row per node or per link, so colouring nodes by cell type is the same column picker as anywhere else.

They are two nodes so that the viewer can be restyled without invalidating the network everything else reads.

```coda-graph
caption: Connectivity's own guide names this pipeline — an edge list in, a network out.
neuron.connectivity as conn
net.build as build { source: preId, target: postId, weight: weight }
out.network as net
conn -> build
build -> net
```

**Connectivity** — or any table with a source and a target column — is the edge list. **Build Network** groups it into links, summing weight where several rows join the same pair; a second `Node attrs` table can join extra columns onto the nodes by id. **Network Viewer** lays the result out and draws it; its `Network` output passes the graph through unchanged, and `Selected` carries back whatever you clicked.

## The filters change what leaves the node

> [!WARNING] `Min link weight`, `Top nodes` and `Hide isolated` are not presentational
> Everywhere else on this card a setting only changes the picture. These three change what
> `evaluate` returns, so they join the provenance key and everything wired after this node goes
> stale.

```coda-params
caption: Order matters — a node kept by `Top nodes` is ranked over the links `Min link weight` left standing.
out.network: minLinkWeight, topNodes, hideIsolated
```

They apply in that fixed order: the weight cut, then the top-N ranking over whatever links survived it, then isolated nodes — including ones the first two stranded. Filtering also recomputes `degreeIn`, `degreeOut`, `weightIn` and `weightOut` on the nodes that remain, so a size encoding cannot contradict the picture beside it.

## Choosing a layout

| Layout                   | Behaviour                                                                    |
| ------------------------- | ----------------------------------------------------------------------------- |
| `force-directed (prefuse)` | lays out each disconnected piece separately and packs the results — **the default** |
| `force-directed`          | settles by simulated repulsion and attraction, live, in a worker |
| `circular`                 | one ring, deterministic                                                       |
| `layered (feed-forward)`   | layers by longest path, or by a column you choose; left to right or top to bottom |
| `spectral`                 | eigenvectors of the graph Laplacian, so structurally similar nodes land near each other |
| `grouped by column`       | rings each group by size, and rings its members inside it — deterministic, no relaxation |
| `from columns`             | reads each node's position straight from two columns you pick                 |

```coda-params
out.network: layout
```

`force-directed` is the one layout that keeps moving after it lands, settling live in a worker where the others arrive finished. `Weight pull` decides how much a link's weight pulls its endpoints together; at 0 a node's mass is still its weighted degree, so weight tells in the spacing either way. `Spectral` is deliberately unweighted — synaptic weights span orders of magnitude and a few strong links would dominate the embedding — and declines to embed fewer than three nodes or a graph with no edges.

A layout is presentational: positions are never saved, and changing it invalidates nothing downstream.

### When the graph is in many pieces

If your network is a lot of small disconnected clusters — a cell-type correspondence graph, a thresholded connectome — `force-directed` draws a uniform blob, and **letting it run longer makes it worse**. Two pieces with no link between them have nothing holding them apart, so the simulation's gravity pulls them into the same place and that pile *is* where it settles.

`force-directed (prefuse)` lays each connected piece out on its own and packs the results side by side. It is the same layout Cytoscape calls "Prefuse Force Directed", and the packing rather than the physics is what makes the difference: on a 36,000-node correspondence graph in 12,000 pieces it produced a readable picture in half a second where the ordinary force layout could not produce one at all.

`Components` switches the packing off. `Link length` sets the scale everything else follows, and `Iterations` has little effect past about 25 — this layout cools itself down rather than improving indefinitely.

## Shape, so the picture survives without colour

`Shape` works like `Colour`: pick `by category` and a column, and each value gets its own mark. **Point it at the same column as `Colour`** for two channels saying one thing, which is what survives being printed in black and white.

```coda-params
out.network: nodeShapeMode
```

There are **six marks and no more**: circle, square, triangle, diamond, cross, plus. Everything past the sixth commonest value becomes a dash. That is deliberately unlike colour, which cycles: a seventh category drawn as a second circle would say two categories are the same thing. With more categories than that, colour is the channel with the capacity.

To pin one, use the **menu on its legend mark**. A pinned mark wins over the ranking, and two keys may share one.

## Arranging nodes by hand

Drag a node in the expanded view and it stays where you put it. Grab a node that is **selected** and the whole selection moves with it, keeping its spacing. Grabbing an unselected node moves that one and leaves the selection alone, and a drag never counts as a click.

- **⤢ still frames everything**, dragged outliers included.
- **↻ throws hand placement away** — the layout runs from scratch.

> [!NOTE] Hand-placed positions last for the session, not for the file
> An arrangement survives closing and reopening the viewer, and the card, the inspector and the
> expanded view share it. It is **not** saved into the document or a share link, so reopening a
> saved file lays the graph out afresh. The caption says `moved by hand` while any of it is.

The `force-directed` layout keeps moving what you drop while it is still settling — freeze it with ❙❙, or wait for it to stop, before arranging.

## Colours cycle, and you pick the palette

A category encoding never runs out: past the end of the palette it comes round to the first colour again, so the twelfth cell type is drawn in a colour rather than in a grey lump. Two categories a palette apart then share a hue, and the caption says `colours repeat` when that happens.

```coda-params
caption: Nodes and links have their own palette, on their own tabs.
out.network: nodePalette, edgePalette
```

| Palette | Colours | When |
| --- | --- | --- |
| `Coda` | 8 | the default, and the only one tuned for both the light and the dark background |
| `Okabe–Ito` | 8 | when the figure has to survive colour-blindness — the colour-universal-design set |
| `Tableau` | 10 | matplotlib's `tab10`, familiar from most plotting stacks |
| `Paired` | 12 | ColorBrewer's, saturated half first |
| `tab20` | 20 | most categories before anything repeats; its first ten *are* `Tableau` |

The other four are published sets used exactly as published, so the pale members of `Paired` and `tab20` are weak on a light background — the price of having twenty colours.

The legend lists twelve keys and then says `+N more`. Everything past the twelfth is still drawn; the cap is on the strip, not on the picture.

## Two colour modes a column cannot express

- **Nodes ▸ Colour ▸ `by connected component`** gives every connected component its own colour, which a drawing answers badly: a force layout can pack two components into one blob and spread one across the canvas. Components are numbered by size, so `1` is the biggest, and they ignore link direction — a component that followed arrows would be a *reachable set*. It is the same partition `Select connected component` uses.
- **Links ▸ Colour ▸ `by upstream node` / `by downstream node`** gives each link the colour of the node at one of its ends. With nodes coloured by type, colouring links by their upstream node shows where each type's output goes without reading a label.

```coda-params
caption: Both live in the styling panel — node colour on the Node tab, link colour on the Link tab.
out.network: nodeColorMode, edgeColorMode
```

The link modes draw no legend of their own: they take the *node* colours, and the node key already names every colour on screen.

> [!NOTE] `by upstream node` is not picking `source` in the category picker
> That works too and answers a different question: it ranks the palette by how many links each
> source has, so it lands on colours that disagree with the nodes an inch away. The point of the
> mode is that they agree.

## Right-click to select

Right-clicking in the expanded view opens a menu instead of the browser's. What it acts on follows the same rule as dragging: a right-click **inside the selection** acts on the whole selection, one outside it acts on that node alone — and never selects it. Right-clicking a **link** acts on both of its ends.

| Command | What you get |
| --- | --- |
| `Select connected` | the anchors plus everything one link away, either direction |
| `Select downstream` | the anchors plus their targets — directed networks only |
| `Select upstream` | the anchors plus their sources — directed networks only |
| `Select connected component` | everything reachable along links, ignoring direction |
| `Copy id` | the ids themselves, one per line, on the clipboard |

Each **replaces** the selection with one that still contains what it started from, so running `Select connected` again reaches one hop further out — which is why there is no "within N hops" box.

`Select downstream` and `Select upstream` are absent on an **undirected** network, where `source` and `target` are an arbitrary order: walking them would follow half of each pair by construction order rather than by the direction of anything.

Right-clicking empty canvas offers the whole-graph verbs instead — `Select all`, `Clear selection`, `Copy all ids` and `Fit to view`.

## Selection is data, not decoration

Clicking nodes writes into `Selected` (a `Neurons` table) and into the `selection` param that drives it — the one setting on this card that is not presentational, because it lives in the saved file and is undoable. Everything in the right-click menu writes it too.

> [!WARNING] A type-level selection reaches `Selected` as `null`, not as a made-up neuron
> A network node's own id is text — a neuron id at neuron level, a type name once nodes are
> grouped by type. `Selected`'s `neuronId` column is filled by parsing that text, so selecting a
> type gives rows with `neuronId: null` rather than a number that only looks like a neuron.
> Downstream fails loudly at the next query instead of silently pretending a type is a neuron.
