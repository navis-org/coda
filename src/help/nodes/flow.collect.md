## What Collect does

Collect is the end of a [For Each](#flow.forEach) loop. Every pass through the loop hands it a result, which it adds to what it already holds. Once the loop has finished, its output is the combined result of all passes.

This lets you use the results of a loop downstream. For example, a loop that fetches one skeleton at a time can pass the whole set on to a [3D View](#out.viewer3d) or a chart:

```coda-graph
 caption: Fetch four hundred skeletons one at a time, then draw them all at once.
 neuron.inputIds as ids
 flow.forEach as loop
 neuron.skeletons as sk
 flow.collect as c
 out.viewer3d as v
 ids -> loop
 loop:item -> sk
 sk:skeletons -> c
 c -> v
```

Without a Collect, the only way to get anything out of a loop is to write files or save images along the way.

## Where to put it

Everything between a For Each and a Collect runs once per element. Everything after the Collect runs only once, on the combined result. The dashed frame on the canvas shows which nodes are inside the loop, and it ends at the Collect.

This means the position of the Collect decides what is repeated. A [Download](#out.download) placed before the Collect writes one file per neuron; the same node placed after it writes a single file containing all of them.

## How results are combined

Collect works on tables, skeletons, meshes and points:

- Tables are stacked like in [Stack Tables](#core.stack).
- Skeletons, meshes and points are stacked like in Stack Neurons.

If a column only appears in some of the passes, it is kept, with empty values for the passes that didn't have it.

> [!WARNING] Every pass has to produce the same kind of data
> If one pass produces skeletons and another a table, there is no sensible way to combine them.
> In that case Collect fails with an error that names the pass where the kind changed.

A Collect without a For Each upstream simply passes its input through unchanged.
