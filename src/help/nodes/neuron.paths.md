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

### Normalising: a share of a population, not a synapse count

`Normalize` divides each connection by one end's total synapse count, and adds `weightNorm` and
the denominator `weightTotal` beside the raw `weight`. With `Collapse types` on the denominator is
the **whole population's** total — `LC4 → PLP1` over everything every PLP1 neuron receives —
because that is the population the weight was summed over.

`Rank by` decides which of the two weakest links orders the result, and the two disagree in a way
that is the point rather than a rounding difference. On the bundled optic lobe, from L1 to DNp02
in four hops: the routes through LPLC2 carry 375 synapses at their narrowest step against 352 for
the route through LC4, so in synapses LPLC2 wins — but LPLC2 takes about 15% of its input from any
one T4 subtype where LC4 takes 61% from Tm3, so as a share the LC4 route wins four times over.
Both numbers are published on every route whichever ranking was used, so one can be read against
the other.

`Min fraction` is applied **as the search grows**, not to the finished ranking: a connection below
it is not followed, so the groups behind it never enter the network at all. That is why the
denominators are fetched hop by hop. A connection whose denominator the dataset does not publish
is never dropped by the floor — a threshold that deleted what it could not measure would report an
absence as a decision — and such a route ranks below every route that could be scored, with an
empty `bottleneckNorm` saying so.

This needs a backend that publishes per-neuron synapse totals: neuPrint does, CAVE and CATMAID do
not, and a dataset answering from an attached edge set refuses on purpose, since a file's weights
over a server's totals is one connectome divided by another.

### N strongest: bounded, not infinite

The search is deliberately bounded — it does not find every route, but the strongest ones. The `N strongest` parameter controls how many routes are kept, and the node will stop searching once it has found that many.

### This node outputs

- **Network**: the pruned graph of routes found.
- **Layout**: a fixed ELK-layered arrangement. It is not user-configurable — any knob takes part in the provenance key and invalidates downstream work. Wire this Layout into a [Network Viewer](#out.network)'s Layout input to use it; when connected, it overrides that viewer's own Layout picker.
- **Paths**: one row per route, ranked by bottleneck. Normalised, it carries `bottleneckNorm` as well — but no denominator column, because a route's two bottlenecks are routinely different steps and one number could name the denominator of neither. The Network output is where each fraction sits beside the total it was divided by.

```coda-params
neuron.paths: maxHops, minWeight, topN, collapseTypes, normalize, normalizeBy, normalizeBasis, rankBy, minFraction
```
