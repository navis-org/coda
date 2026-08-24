```coda-graph
caption: Get the top 10 matches
neuron.inputIds as in1 {ids: "10001"}
neuron.inputIds as in2 {ids: "21312"}
neuron.paths as p
out.network as net
in1 -> p:sources
in2 -> p:targets
p -> net
```

### Ranking looks for bottlenecks

To rank paths this node uses the minimum synaptic weight along any single hop in a route, not the sum across the whole path — so a long route through consistently strong connections beats a short route that includes one very weak link.

### Type-level vs. neuron-level search

With `Collapse types` on (the default), the search runs on the **type-level graph** — LC4 is one node, not hundreds of individual LC4 neurons. This changes what routes are *found*: a pathway like LC4 → PLP1 → DNp01 is discovered even when no single PLP1 neuron both receives from an LC4 *and* projects to a DNp01.

`Min synapses` filters after type-level summing: it thresholds total traffic between cell types. With `Collapse types` off, it filters individual neuron-to-neuron connections.

### N strongest: bounded, not infinite

The search is deliberately bounded — it does not find every route, but the strongest ones. The `N strongest` parameter controls how many routes are kept, and the node will stop searching once it has found that many.

### This node outputs

- **Network**: the pruned graph of routes found.
- **Layout**: a fixed ELK-layered arrangement. It is not user-configurable — any knob takes part in the provenance key and invalidates downstream work. Wire this Layout into a [Network Viewer](#out.network)'s Layout input to use it; when connected, it overrides that viewer's own Layout picker.
- **Paths**: one row per route, ranked by bottleneck.

```coda-params
neuron.paths: maxHops, minWeight, topN, collapseTypes
```
