The exit of a [For Each](#flow.forEach) loop. Each pass hands it a result; it stacks that onto what it already holds, and what comes out the far side is the whole set.

Without it, the only way out of a loop is a side effect — a file written, an image saved. With it, a loop that fetches one neuron at a time can hand the whole collection to a [3D View](#out.viewer3d) or a chart.

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

### It is where the loop stops

This is the part worth knowing. Everything between a `For Each` and a `Collect` runs once per element; **everything after a `Collect` runs once**, on the finished total. That is what the dashed loop frame on the canvas is drawing — the frame ends here.

So where you put it decides what repeats. A [Download](#out.download) *before* a Collect writes one file per neuron; the same node *after* one writes a single file holding all of them. Both are useful and they are not the same workflow.

### Passes that differ are stacked, not dropped

Tables stack the way [Stack Tables](#core.stack) does and geometry the way Stack Neurons does. A column that only some passes carried is kept, with `null` for the passes that had it missing — quietly losing a column because one neuron lacked a soma tag would be worse than an untidy table.

> ![WARNING]
> Every pass has to produce the *same kind*. If one pass yields skeletons and another a table, there is nothing sensible to stack, and Collect names the pass where it changed rather than silently keeping the last one — a Collect holding only the final pass looks exactly like a loop that never ran.

### On its own it does nothing

A Collect with no `For Each` above it passes its input straight through. That is not an error: it is a graph halfway through being built, and refusing would put a red mark on the node that is not the one to fix.
