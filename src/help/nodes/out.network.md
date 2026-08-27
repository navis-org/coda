## Two nodes for one job

1. **`Build Networks`** turns an edge table into nodes and links, with the roll-ups a node-link drawing needs — in/out degree, in/out weight — derived automatically.
2. **`Network Viewer`** draws the result. Both halves are ordinary Coda attribute tables, one row per node or per link, so coloring nodes by cell type is exactly the same column picker as anywhere else.

```coda-graph
caption: Connectivity's own guide names this pipeline — an edge list in, a network out.
neuron.connectivity as conn
net.build as build { source: preId, target: postId, weight: weight }
out.network as net
conn -> build
build -> net
```

1. **Connectivity** — or any table with a source and a target column — is the edge list.
2. **Build Network** groups it into links, summing weight where several rows join the same
   pair, and derives node degree and weight from what survives. A second `Node attrs` table can
   join extra columns onto the nodes by id.
3. **Network Viewer** lays the result out and draws it. Its own `Network` output passes the graph
   through unchanged — a viewer here is a tap, not a dead end — and a second output, `Selected`,
   carries back whatever you clicked.

> [!NOTE] Why does this need two nodes?
> First, because they both `Build Network` and `Network Viewer` are highly customizable and a single node would be overloaded with parameters/settings. Second, by splitting them, the user can play with the viewer without invalidating everything else that uses the raw network.

## `Network Viewer`'s filters change what leaves the node, not just what you see

> [!WARNING] `Min link weight`, `Top nodes` and `Hide isolated` are not presentational > Everywhere else on this card, a setting only changes the picture. These three change what `evaluate` returns, so they join the provenance key and everything wired after this node goes > stale — which is why the `Filter` tab carries its own warning rather than sitting quietly beside `Layout` and the rest.

```coda-params
caption: Order matters — a node kept by `Top nodes` is ranked over the links `Min link weight` left standing.
out.network: minLinkWeight, topNodes, hideIsolated
```

They apply in that fixed order: the weight cut first, then the top-N ranking over whatever links survived it, then isolated nodes — including ones the first two filters stranded. Ranking before the cut would answer a different question ("the biggest players in the whole graph" rather than "in the graph you're looking at"). Filtering also recomputes `degreeIn`, `degreeOut`, `weightIn` and `weightOut` on the nodes that remain, because a node still claiming eight links after four were cut would drive a size encoding that contradicts the picture beside it.

## Choosing a layout

| Layout                   | Behaviour                                                                    |
| ------------------------- | ----------------------------------------------------------------------------- |
| `force-directed`          | settles by simulated repulsion and attraction, live, in a worker — the default |
| `circular`                 | one ring, deterministic                                                       |
| `layered (feed-forward)`   | layers by longest path, or by a column you choose; left to right or top to bottom |
| `spectral`                 | eigenvectors of the graph Laplacian, so structurally similar nodes land near each other |
| `grouped by column`       | rings each group by size, and rings its members inside it — deterministic, no relaxation |
| `from columns`             | reads each node's position straight from two columns you pick                 |

```coda-params
out.network: layout
```

`force-directed` is the one layout that runs rather than lands in a single step. `Weight pull`
decides how much a link's weight pulls its endpoints together; turning it to 0 does not turn
weight off — a node's mass stays its weighted degree, so weight still tells in the spacing even
with the pull removed. `Spectral` is deliberately unweighted, since synaptic weights span
orders of magnitude and would let a few strong links dominate the embedding rather than the
graph's actual shape — and it declines to embed fewer than three nodes, or a graph with no
edges at all, rather than guessing.

A layout is presentational: positions are never saved, and changing it invalidates nothing
downstream.

## Selection is data, not decoration

Clicking nodes writes into `Selected` (a `Neurons` table) and into the `selection` param that
drives it — the one setting on this card that is not presentational, because it lives in the
saved file and is undoable like everything else your click reaches.

> [!WARNING] A type-level selection reaches `Selected` as `null`, not as a made-up neuron
> A network node's own id is text — a neuron id at neuron level, a type name once nodes are
> grouped by type. `Selected`'s `neuronId` column is filled by parsing that text, so selecting a
> type gives you rows with `neuronId: null` rather than a number that only looks like a neuron.
> Downstream fails loudly at the next query instead of silently pretending a type is a neuron.
