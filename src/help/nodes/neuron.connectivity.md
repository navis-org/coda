The orientation is always **presynaptic → postsynaptic**, regardless of which `Direction` you
queried. Can be wired straight into Build Network with `Source: preId, Target: postId`.

### Direction and hops

**`direction: both`** at hops > 1 finds the undirected neighbourhood reached from either end at the same hop distance — not two independent directional cones stitched together. An edge found at an earlier hop keeps the direction label it was first assigned.

> [!WARNING]
> The traversal is iterative per-hop BFS: each hop queries the entire frontier as one request, unchunked. A large frontier can fail at the transport layer, and the frontier multiplies by the average partner count each hop — `Min weight` is the only brake.
>
> For large queries, consider providing a local edge table via the `Edge data` button on the dataset card.


### Example: Edges to Build Network to Network Viewer

```coda-graph
caption: Connectivity Graph wired into the pattern for visualization
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
