Runs everything wired after it once per element — one row, one skeleton, one mesh, or every element sharing a value of a column. It is the automatic counterpart of [Select One](#core.selectOne), which walks the same collection by hand.

The two things it exists for are the two things a browser cannot do in one pass: **write a file per neuron**, and **render an image per neuron**. Both are workloads where holding the whole result at once is the problem.

```coda-graph
 caption: Fetch one skeleton at a time and write each to its own SWC file.
 neuron.inputIds as ids
 flow.forEach as loop
 neuron.skeletons as sk
 out.download as dl
 ids -> loop
 loop:item -> sk
 sk:skeletons -> dl
```

### Nothing downstream knows it is in a loop

There is no sub-workflow to build and no nested canvas. The node holds which element it is on, that number is part of its cache key, and everything downstream re-runs because its key moved — exactly as it would if you had edited a parameter above it. So any node can sit inside a loop, and none of them needed changing.

Which nodes those are is drawn on the canvas: a dashed frame around **the region**, meaning everything reachable from this node that is not past a [Collect](#flow.collect). If a node you expected to loop is outside the frame, the wires say why.

### It holds one element at a time, and that is the point

Four hundred skeletons fetched at once is a few gigabytes. Fetched one at a time, only one is live — the session geometry cache is bounded by bytes and evicts the rest, and each node keeps only its latest result. That is what makes a set too large to load still possible to save.

### Element, or group

- **element** — one row, one skeleton, one mesh per pass.
- **group of a column** — one pass per distinct value, carrying *every* element that shares it. "For each cell type, fetch its neurons and save an edge list" is this mode. Elements with no value form a single `(none)` group rather than one group each.

_First N_ is how you try a loop on the first ten before committing an afternoon to it. It counts
elements, not passes, so it means the same ten neurons whatever _Batch size_ is set to.

```coda-params
flow.forEach: mode, groupBy, batch, limit
```

### Batch size is how you make it fast

Every backend already fetches several neurons at once — six at a time from neuPrint, eight from
CATMAID. A loop asking for **one** neuron per pass reduces that to one, so a one-at-a-time loop is
several times slower than it needs to be. _Batch size_ hands each pass a run of elements instead,
which gets the concurrency back while still holding only a batch rather than the whole collection.

> ![WARNING]
> Leave it at 1 when each pass renders a picture. A viewer handed twenty neurons draws one image
> of twenty, not twenty images. When each pass writes a file per neuron it is free — the files are
> named by neuron either way — and 20 is a good place to start.

### Writing files needs the Run loop button, not Run

> ![WARNING]
> A browser silently stops honouring downloads somewhere past about fifty from a single gesture. A loop over four hundred neurons therefore cannot write files the ordinary way, and _Run loop_ on the card is what routes them somewhere that works. Pressing Run in the toolbar still iterates and still fetches — it just has nowhere to put the files.

_Run loop_ asks where the files should go, then runs. There are two answers and the card says which one your browser gives you:

1. **A folder you pick.** Files are written straight to disk as they are produced, one at a time, with no limit on how many. Chromium only.
2. **One zip.** Works everywhere, but every file is held in the tab until the loop finishes — which gives back some of the memory the loop was saving.

Files are named by the element, with a zero-padded ordinal in front, so a folder of four hundred sorts in loop order.

### Rendering an image per element

A picture is read from a **live viewer**, not from the wire — so the 3D View or chart card feeding the Download has to be on screen and not collapsed for the whole loop.

The camera does not move between elements by default. That is right for a set of images meant to be compared at one scale, and wrong when the neurons are nowhere near each other; [3D View](#out.viewer3d)'s _Frame each_ switch is the other answer.

### It runs on Run, never while you type

Marked expensive on purpose. A loop that fired on every keystroke would be four hundred queries and four hundred files per character typed. And a loop that has already finished does not re-run when nothing above it changed — press _Run loop_ to do it again deliberately, which is what you want when the effect is a folder of files.

A pass that fails does not stop the loop. The other elements still run, and the card says how many failed and which.
