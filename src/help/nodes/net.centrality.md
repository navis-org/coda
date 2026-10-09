Network Centrality computes betweenness, closeness, PageRank, eigenvector centrality and Louvain communities for every node in a network. Each measure you switch on adds a column to the nodes (`betweenness`, `closeness`, `pagerank`, `eigenvector`, `community`), and the network passes through with those columns attached.

The node has no plot of its own. Instead, wire it into [Network Metrics](#net.metrics), where `betweenness` and `community` show up in the scatter's column pickers, or into the [Network Viewer](#out.network) to use them for colour or size:

```coda-graph
caption: Compute centrality, then plot it with Network Metrics.
net.build as build
net.centrality as cent
net.metrics as met
build -> cent
cent -> met
```

Centrality is slow to compute, so this node only runs when you hit **Run**. Betweenness walks every link once per node, which on a large network takes minutes. `Sample` (see below) is a way to speed this up.

## The measures

- **Betweenness**: how many of the shortest paths between other nodes pass through this one. A high value means the node is a bottleneck.
- **Closeness**: how short the paths *into* this node are, on average (harmonic closeness). A high value means the rest of the network reaches it quickly.
- **PageRank**: weight flowing in from upstream partners, and from their upstream partners. Input from an important node counts for more than input from an obscure one.
- **Eigenvector**: the classical version of the same idea. Off by default, because on a network where signal mostly flows forwards it gives zero to every node that is not part of a loop, which is usually most of them. A column of zeros here is therefore expected, not a bug.
- **Communities**: Louvain groups, i.e. sets of nodes that are more densely connected to each other than to the rest of the network. Numbered from largest to smallest.

> [!TIP] Only switch on what you need
> A measure that is switched off doesn't produce a column at all. Betweenness and closeness come
> from the same sweep, so asking for both costs barely more than asking for one. The other
> measures are cheap in comparison.

## The summary row

Besides the network and a `Node stats` table, the node outputs a `Summary` table with a single row describing the whole network:

| Column | What it says |
| --- | --- |
| `sources` | How many nodes the sweep started from. Equal to the number of nodes unless `Sample` is set. |
| `meanPathLength` | The average number of steps between two nodes that can reach each other. Pairs that can't reach each other are left out (rather than counted as infinitely far apart). |
| `diameter` | The longest of those shortest paths. Empty whenever `Sample` is used, because a maximum from a sample is only a lower bound. |
| `reachable` | The fraction of all ordered pairs of nodes where one can reach the other. Low values are normal for a filtered connectome. |
| `communities`, `modularity` | How many communities Louvain found, and how clearly separated they are. Around 0 means no better than chance; 0.3 and up usually indicates a real division. |

The row always has the same columns, with blanks for measures that were switched off. That way, rows from several runs stack cleanly in a [Collect](#flow.collect).

## Sampling

```coda-params
net.centrality: samples, weighted
```

With `Sample` set, the node picks that many nodes at random, runs the sweep only from those and scales the result up. A few hundred nodes are usually within a percent of the exact answer and can turn an hour into a minute. 0 (the default) means every node, which gives the exact answer. The random draw is seeded, so the same network with the same `Seed` gives the same numbers every time.

`Weighted paths` changes what "short" means. When off, the length of a path is the number of steps. When on, each link has a length of 1/weight, so strong connections make short paths. Parallel links are added together first, so the result is the same whether or not `Merge parallel links` was ticked in [Build Network](#net.build).

## Advanced settings

```coda-params
net.centrality: seed, resolution, damping
```

- `Resolution` controls the size of Louvain communities: above 1 gives you more, smaller communities; below 1 fewer, larger ones.
- `Damping` is PageRank's probability of following a link rather than jumping to a random node. 0.85 is the standard value.
