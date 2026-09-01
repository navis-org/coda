```coda-graph
caption: Centrality first, then the card that plots it.
net.build as build
net.centrality as cent
net.metrics as met
build -> cent
cent -> met
```

No card of its own — its output is columns, and the surfaces that draw columns already exist. Wire it into [Network Metrics](#net.metrics) and `betweenness` and `community` show up in the scatter's pickers; wire it into the [Network Viewer](#out.network) and they are a colour and a size.

It runs on **Run** only. Betweenness walks every link once per node, so on a big network it is minutes, not milliseconds — see `Sample` below.

## The five measures

Each is a different answer to "which node matters", and they disagree on purpose.

- **Betweenness** — how many of the shortest routes between other nodes pass through this one. High means a bottleneck: cut it and traffic has to go the long way round.
- **Closeness** — how short the routes *into* this node are, on average. High means the rest of the network reaches it quickly.
- **PageRank** — weight flowing in from upstream partners, and from theirs. Being pointed at by an important node counts for more than being pointed at by an obscure one.
- **Eigenvector** — the same idea in its classical form, and off by default. On a network where signal mostly flows forwards it gives zero to everything that is not part of a loop, which is most of it — a column of zeros that looks like a bug and is the measure working as defined.
- **Communities** — Louvain groups: sets of nodes wired more densely to each other than to the rest. Numbered largest first.

## The summary row

| Column | What it says |
| --- | --- |
| `sources` | How many nodes the sweep started from. Equals the node count unless `Sample` was set. |
| `meanPathLength` | The average number of steps between two nodes that can reach each other. Nodes that cannot are left out, not counted as infinity. |
| `diameter` | The longest of those shortest routes. **Empty whenever `Sample` was used** — a sampled maximum is only ever a lower bound, and printing one would be a guess wearing a number's clothes. |
| `reachable` | Of all ordered pairs of nodes, the share that can actually get from one to the other. Low is normal for a filtered connectome. |
| `communities`, `modularity` | How many groups Louvain found, and how clearly separated they are. Roughly 0 means no better than chance; 0.3 and up is usually a real division. |

The row is always the same width, with blanks for whatever was switched off, so a [Collect](#flow.collect) of several runs stacks cleanly.

## Sampling, and what it buys

```coda-params
net.centrality: samples, weighted
```

`Sample` picks that many nodes at random and sweeps only from them, then scales the result up. A few hundred is usually within a percent of the exact answer and turns an hour into a minute. 0 means every node, exactly. The draw is seeded, so the same graph and the same `Seed` give the same numbers twice.

`Weighted paths` changes what "short" means. Off, a path is a count of steps. On, a link's length is 1/weight, so a strong connection is a short path and a one-synapse connection is a long one. Parallel links are added together first, so the answer does not depend on whether `Merge parallel links` was ticked upstream in [Build Network](#net.build).

> [!NOTE] Only turn on what you will read
> Each measure off is a column that is not offered rather than a column of blanks. Betweenness and closeness share one sweep, so having both costs barely more than one; the others are cheap next to it.

## The advanced settings

```coda-params
net.centrality: seed, resolution, damping
```

`Resolution` above 1 makes Louvain find more, smaller communities; below 1, fewer and bigger. `Damping` is PageRank's chance of following a link rather than jumping somewhere random — 0.85 is the standard value and there is rarely a reason to move it.
