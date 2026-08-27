# Loops

`For Each` and `Collect`: what a loop is, why it is not a subgraph, and the four things that had
to be decided rather than derived.

Read this before changing anything in `runLoop`, `loopRegion`, or the file sink. Most of what is
here exists because the obvious version was tried and was wrong in a way that reads as something
else — a hang, a stray file, an image of the wrong neuron.

## The whole mechanism is one number in a hash

A loop does not have an execution model. `Scheduler.loopIndex` holds which element a `For Each`
is on and `desiredKeys` folds it into that node's provenance key; advancing it re-keys the node,
invariant 4 carries the change to every descendant, and the region re-runs — because **from a
region node's point of view, a new pass is indistinguishable from somebody having edited a param
upstream**. There is no second executor, no nested graph, no re-entrant scheduler pass, and
nothing new in a saved file.

That is why `Select One`'s header could already call itself "the manual counterpart to a `For
each`" before this existed. The two nodes are the same slice of the same collection; the only
difference is who advances the index.

### Not a subgraph, and that was the first decision

`_TODOs.md` proposed the obvious shape: a collapsible group with the loop body built inside it.
It was rejected on `docs/canvas.md`'s own terms. A group frame in Coda **owns nothing** —
membership is a list of node ids, the box is derived, and `parentId` was refused because it
re-bases every child's `position`, which five subsystems read absolutely. Making groups into
scoping constructs means boundary ports, a nested document model, a nested canvas, and a second
meaning of "position". The region is derived from the wires instead, and costs a graph walk.

The trade is that a loop's extent is **invisible in the document** — you cannot see from the JSON
which nodes repeat. That is what `LoopLayer` is for: the dashed frame is not decoration, it is
the only way to tell whether the Download you just added is inside the loop or after it, and the
two do completely different things.

## The region

`loopRegion(graph, beginId)` in `graph.ts`: everything reachable from the begin node, **stopping
at** a `loop: 'end'` node rather than before it.

That asymmetry is the definition. An exit folds once per pass, so it is inside; everything after
it reads the finished accumulation, so it is outside. Stopping before it would run the fold once,
on the last element; stopping after it would re-run the whole tail of the graph per element.

**Walked forward rather than intersected.** The tidier-looking `descendants(begin) ∩
ancestors(exit)` is wrong on a fan-out: a node reachable by a path that never touches an exit
belongs in the region even when *another* path to it goes through one, and the intersection
silently drops it.

### A loop runs at the position of the last node of its region

Not at its begin node, and this is a real ordering bug rather than a preference. Consider a body
that also reads a second branch from beside the loop. Every ancestor of every region node
precedes the *last* region node in the topological order, so triggering there means everything
the body reads from outside itself is in hand. Triggering at the begin node runs the body before
that branch has been reached, so every pass sees nothing — on the first run of a session, which
is when nobody suspects the scheduler. `scheduler.test.ts` pins it with a joined branch added to
the graph *after* the body, so a naive position ordering fails the test.

### Nested loops, and the walk they share

`runNodes` is the only place that knows the ordering rule, and both the top-level walk and **each
pass of a loop** go through it. That is what makes nesting work rather than merely look like it
should: `runLoop` used to dispatch its region through `executeNode`, which cannot start a loop, so
an inner `For Each` ran exactly once per outer pass and read the *outer* loop's index as its own —
while this document claimed the case was handled. `loopsIn` returns outermost first, an outer loop
claims its region's nodes, and the inner one is planned again one level down, inside each pass.

## A settled loop does not re-run

The first version reset `loopIndex` at the top of every run, on the reasoning that "Run means do
the loop". It is worse in two ways that only show up in use:

- the badge reads `ok` while Run still does four hundred queries, and
- with auto-run on, *any* edit anywhere in the graph re-runs the whole loop and re-writes every
  file.

So a loop obeys `out.download`'s existing contract instead — "a run in which nothing upstream
changed does not re-execute this node, so pressing Run twice writes one file". The index is left
where the last loop finished precisely so `runLoop` can ask whether every region result still
answers its current key, and skip when it does. Re-running a settled loop is a deliberate
gesture: **Invalidate Results**, or the card's own _Run loop_ button, which does both.

**Freshness is only half the question, and `loopDone` is the other half.** Freshness describes a
*pass*: cancel a four-element loop after the second and every region entry answers the key for the
pass that completed, with the index sitting at 1. Asked "is everything current?", that loop says
yes — so the next Run settles it untouched and elements three and four are silently never
processed. Finishing is a fact about the loop and nothing in the key can carry it, so it is
recorded beside the index: cleared when a loop starts iterating, set only when it reaches the end.

**A loop exit is never answered from cache mid-pass.** A `Collect`'s other input is the previous
pass's result, which is not in its key and cannot be — so a cache hit does not determine its
output, which is the one place invariant 4's premise does not hold. Skipping it left
`pass.accumulations` unfed and the running total restarting from the following pass, so the loop
finished holding only its own tail with every node reading `ok`. The way in is any loop re-run
over ground it has covered.

The consequence to know: nothing downstream of the loop needs a special "loop-invariant" key.
Because the index settles at `count - 1` rather than resetting, `refreshStates` computes the same
keys the loop finished on, and a `Collect` and everything after it read `ok`. An earlier design
did reset it, and needed an invariant-key rule to stop `Collect` invalidating itself forever —
which is a hang, not a wrong answer. That rule is gone; the test that would have caught it
(`settles: a second Run over an unchanged graph iterates nothing`) is not.

## One statement of the pass count

`nodes/flow/plan.ts` — `loopPlanFor` and `loopPlanOf`. Three surfaces have to answer "how many
passes, and what is each one called": the node's `loopPlan`, the card (which must say `412
neurons` before anything has run and cannot build an `EvalContext`), and the canvas frame's
caption. Each wrote the rule out, and the third read `params.groupBy` **raw** where the other two
resolved it through the column machinery — so a picker sitting on its declared default made the
card say `412 groups` and the frame drawn around it say `0`, about the same node at the same
moment. That is invariant 5's failure exactly.

`loopPlanOf` is the extra hop the UI takes: it resolves the column with `resolveColumn` before
calling `loopPlanFor`, so a card and a frame cannot resolve a picker differently from the node
they describe.

## Batching is the parallelism

The obvious ask is threads, and for both of this node's cases they are the wrong tool. Fetching
is I/O-bound: a Web Worker does not make `fetch` faster and the main thread is idle during one
anyway. Rendering cannot be parallelised at all — one WebGL context, one canvas, and
`CaptureBridge` deliberately reads the drawing buffer back *in the same task* as the render.

What the loop actually did was **throw away concurrency it already had**. Every backend fans out
over neuron ids through `mapWithConcurrency` with a per-backend cap — 6 in flight on neuPrint, 8
on CATMAID, 3 for CAVE meshes, 16 for CAVE's chunk graphs, 4 for ROI meshes. Outside a loop,
`Skeletons` over 400 neurons runs `mapWithConcurrency(missing, 6)`; inside one, each pass asks for
exactly one neuron, so it is six windows of one, four hundred times. `For Each → Skeletons` was
several times slower than the un-looped node, as a property of the division rather than of the
work.

`Batch size` is the fix: a pass carries N elements instead of 1, so the backend gets a run to fan
out over and the memory bound moves from one element to N rather than being given up. Probed on
the mock optic lobe over 12 neurons: batch 1 → 12 passes holding one each; batch 4 → 3 passes
holding four; batch 12 → 1 pass. Identical collected output in all three.

**The default is 1 because there is no safe larger one**, and that is a statement about the two
uses rather than caution. A batch is free when a pass writes a file per neuron — the exporter
already names each file by its own id, so twenty SWCs come out of one pass exactly as twenty
passes would produce them. It is wrong when a pass *renders*: a viewer handed twenty neurons
draws one picture of twenty, not twenty pictures. Both are stated uses, so the choice is the
user's, and the card offers it only where it is unambiguously good advice — a region that writes
files, long enough to matter, running one at a time.

Two details that are easy to get wrong and are pinned:

- **`First N` counts elements, not passes.** "Try it on the first ten" means ten neurons whatever
  the batch size, which is what somebody who set both of them means.
- **A batched pass contributes only its ordinal to a filename.** `planExport` already appends
  each item's own id, so keeping the pass label as well produced twenty SWCs all prefixed with
  the batch's *first* neuron — twenty files that read as twenty copies of one. `LoopIteration.size`
  is what the namer asks; it is also what puts `+19` in the progress line rather than pretending
  a pass is one neuron.

Group mode ignores the setting: a group is already however many elements share a value, and
batching groups on top of that is a second division of one collection with nothing on screen to
tell the two apart.

### Where a thread would genuinely help

`src/pyodide/engine.ts` holds **one** worker, so a loop doing NBLAST or Clean Skeletons per
element serialises through it. A worker pool is the one place in this codebase where threads are
the right answer — and the cost is real, since Pyodide is a multi-megabyte runtime plus packages
per worker, and the single-worker design looks deliberate. Measure a per-element Python loop
before building it.

True parallel *passes* are a much deeper change: each node has exactly one cache entry keyed by
provenance (invariant 4), so running passes 3 and 4 at once means two values under one key. It
would need per-pass cache scoping, per-pass node states, and a progress model describing N passes
at once — and the render case still could not use it.

## The pairing is enforced, not documented

`registerNode` throws when `loop: 'begin'` and `loopPlan` do not arrive together. Half a loop
fails **silently and asymmetrically**: the scheduler falls through and runs the node once, while
`loopsIn` still derives a region for it and `LoopLayer` still draws a frame captioned `for each`
around nodes that will run exactly once — a loop node that quietly is not one, with the canvas
asserting that it is. Thrown at registration for the duplicate-type reason: it is a fact about
the node pack, so it should fail when the pack is imported rather than on somebody's first Run.

## Group mode is linear, and the memo is what makes it so

`groupIndex` in `iterables.ts` holds key → row indices in a `WeakMap` on the collection's
identity. Without it, group mode asked `groupKeys` once per pass to *name* the pass and `groupOf`
once per pass to *select* it, and both were full scans of the key column with a `String`
allocation per row — about 66 million string conversions and 400 discarded `Set`s on a 165k-row
neuron table, on the main thread, during the loop whose progress bar somebody is watching.

Keying on identity is sound for the reason `geometryCache` can hand back the array it holds:
table columns are immutable by convention here, so a `TableValue` that is the same object has the
same rows in it.

## A loop iterates only when somebody asked it to

`For Each` is `expensive`, and here that is entirely a safety property — slicing one element out
of a collection already in hand is as cheap as work gets, which is why `Select One` is `cheap`.
`cheap` means the 180ms pass after every keystroke, and a loop that fires four hundred backend
queries and writes four hundred files per character typed is not a node anybody can leave on a
canvas. Exactly `out.download`'s reasoning.

Deferring has to happen **before** the iteration, not per pass. Iterating four hundred times to
defer each pass's expensive nodes individually is four hundred passes of pure overhead, and any
`cheap` node in the region really would run four hundred times per keystroke.

**There are two doors and the cost marking only covers one.** Auto-run schedules `runFull` —
`mode: 'full'` — so the `cost: 'expensive'` deferral never fires there, and any upstream edit
re-iterated the whole loop 700ms later: precisely the scenario the marking is documented to
prevent, arriving through the door it does not watch. `RunOptions.automatic` says who started the
run, which is the question actually being asked, and a loop defers on it whatever the mode says.

## An empty collection runs the region once, on nothing

Zero passes is a real answer, and the tempting reading — "no passes, so nothing to do" — is what
left every node in the region holding the *previous* run's results under an `ok` badge. The port
went on carrying last time's neuron and a 3D viewer went on drawing it, with nothing saying the
collection was now empty.

So the region executes exactly once with an out-of-range index, which makes the begin node emit
`emptyElement` and everything below it compute honestly on nothing. What does **not** happen is
`onIteration`: no element was iterated, so no file is written and no picture is captured. That is
the whole distinction between "ran on an empty collection" and "ran once".

## Collect is a fold, not a special case

`ctx.accumulated` carries what a `loop: 'end'` node returned on the previous pass, so `evaluate`
is `(accumulated, input) => accumulated'` — an ordinary function of its arguments, deterministic,
testable with no scheduler in sight (`collect.test.ts` does exactly that).

The alternative was a node the scheduler assembled the answer *for*, which would have put
`stackTables` and `stackGeometry` in `src/core` and inverted the layering for one call. The
accumulator lives in the pass rather than in the cache, for `previews`' reason: a half-finished
total stored under a provenance key would be the answer *for* that key, so a loop cancelled at
element 40 of 300 would leave a Collect claiming to hold all three hundred and nothing would ever
re-run it.

## A failing element does not end the loop

Four hundred neurons with one unreadable skeleton is three hundred and ninety-nine files worth
having. Abandoning them is the refusal `docs/limits.md` argues against, so the loop counts
failures and writes them onto the begin node's cache entry as a warning — the same channel
`ctx.warn` uses, reached differently because the entry was already sealed at the last pass and
what is being reported is a property of the *loop* rather than of any one element.

## Side effects: why `onIteration` exists

`useDownloads` already establishes that a file is written by the UI watching runs rather than by
`evaluate`. A loop breaks that, twice over, and either half alone would be enough:

- **`RunSummary.executed` is a set of node ids.** A Download that ran four hundred times is in it
  once, so a driver reading it after the run writes one file — the last element's — and the other
  three hundred and ninety-nine never existed.
- **A picture is read off a live viewer**, through `exportSourceFor`, not off the wire. The image
  for element 273 exists only while React is drawing element 273, which is a moment inside the run
  and gone by the end of it.

So `SchedulerHost.onIteration` is **awaited** after every pass. The host yields a frame before
capturing (only when a Download in the region actually asks for an image — otherwise four hundred
elements pay several seconds of latency for nothing), writes the files, and hands back.

`RunSummary.loopNodes` exists for the same reason and is the other half: `useDownloads` excludes
it, or a loop's Download would get one extra write at the end holding the last element, with
nothing to explain it.

**What a Download produces is stated once**, in `planDownload`. The loop's driver and the card's
button differ only in where the bytes land, and the two dispatches had already parted company —
the loop's copy dropped `planExport`'s truncation report, so it silently wrote the first fifty of
a set and said nothing. `planDownload` returns named byte blobs and writes no file; `runDownload`
hands them to the browser and `runIteration` hands them to a sink. It is async because a PNG from
a vector viewer is rasterised, which replaced a sentinel — an `SVGSVGElement` smuggled through
`ExportFile.parts` under a fake mime — that put an undeclared invalid state into a shared type.

The store must not import `src/ui`, so the handler is **installed** rather than called —
`setIterationHandler`, in `registerExportSource`'s idiom. Absent is a legitimate state and means
the loop still iterates, the region still executes and a Collect still accumulates; only the
files are not written, which is the half that needs a browser.

### The observed-schema walk is suppressed mid-loop

`onStateChange` re-walks `observedSchemas` on every node state transition, and a 400-element loop
over a 10-node region fires it about eight thousand times. No pass of a loop can change an
observed *schema* — it is the same nodes producing the same shape with different rows — so the
walk is skipped while `looping` and taken once when the run ends. Left in, it cost more than the
work did.

## Files: two routes, because no single one works

`MAX_MORPHOLOGY_FILES` is 50 and its own note says why: a browser asked for six hundred downloads
at once stops honouring them somewhere in the middle, with no error, which reads as the export
having half-worked. A loop over four hundred neurons hits that on the first try, so `fileSink.ts`
replaces the `<a download>` path **inside a loop only** — the single-shot Download is unchanged.

| | where the bytes go | holds in memory | available |
| --- | --- | --- | --- |
| `folder` | straight to disk, one file at a time | nothing | Chromium (File System Access) |
| `zip` | one archive at the end | everything | everywhere |

The folder route is the one worth having: the entire reason to iterate rather than fetch four
hundred skeletons at once is that a loop holds one at a time, and a zip gives that back — 400 ×
2 MB of SWC accumulates in the tab until the archive is sealed. The card says which route is in
force, because the trade is real and not guessable.

**The picker cannot be asked for from inside a run.** `showDirectoryPicker` needs transient
activation, and by the time the scheduler reaches the loop the click that pressed Run is spent.
That is the whole reason the card has a _Run loop_ button: it picks a destination, arms it,
invalidates the node and runs, in that order. The sink is parked in a module-level slot rather
than in the store, because a `FileSystemDirectoryHandle` is not serialisable and has no business
in the autosave, the undo history or a shared file.

`src/ui/zip.ts` is stored (method 0), not deflated. Everything a loop writes is text, which is
already compressed in transit and on disk; `CompressionStream` would avoid a dependency but is
async per entry and does not know its output length until it finishes — which is exactly the
field a local header has to carry. It refuses past 4 GB or 65,535 entries rather than emitting an
archive whose central directory describes the wrong offsets, and that refusal earns its place on
`docs/limits.md`'s terms: there is no useful answer on the other side, only a corrupt file.

## The camera does not move, unless you say so

`CameraRig` frames exactly three times — first extent, remount, Reset view — and deliberately
*not* on a bounds change, because a re-run pulling the camera out from under a scene somebody had
turned is the bug that rule was written for.

Under that rule a loop rendering four hundred neurons frames on the first and draws the other 399
under its camera. That is **right** for a contact sheet meant to be compared at one scale and
useless when the elements sit far apart in the volume, so it is a switch rather than a new rule:
`out.viewer3d`'s _Frame each_, off by default, adding a fourth thing that moves the camera and
changing nothing while it is off.

The capture itself needs nothing special. `CaptureBridge` renders and calls `toDataURL` in the
same task, so it does not depend on the compositor — only on React having committed this
element's geometry, which is what the awaited frame in `onIteration` buys.

The limitation that carries over: a picture comes from a viewer that is **on screen and not
collapsed**. It is already true of the single-shot Download and is stated on the card; in a loop
it matters more, because the failure is four hundred missing images rather than one.

## Not exported

Both nodes are in `NO_EMITTER` for both exporters, and it is the one refusal there that is about
the *shape* of the output rather than about a backend. Every other node becomes one cell; a loop
has to put the cells of its region inside itself, indented, which is a change to how the walk
assembles a notebook rather than an emitter that could be written beside the others. A `for` loop
is the most natural thing in either language, so it is worth doing — it is simply not a cell.
