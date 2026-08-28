# Core mechanics

The scheduler-adjacent rules: caching, auto-run, and reference edges.

Moved verbatim out of `CLAUDE.md`.


## Three caches, and the two controls that clear them

`Invalidate Results` and `Clear Cache`, in the node's context menu and side by side in the
inspector. They are different layers and the difference is not cosmetic:

| | what it holds | keyed by | lives | cleared by |
| --- | --- | --- | --- | --- |
| the scheduler's result cache | what `evaluate` returned | provenance — `hash(type, params, upstream)` | the session | Invalidate Results |
| the table cache (`loadCachedTable` → IndexedDB) | what a *server* returned | what was fetched | a month | Clear Cache, or the dataset card's ⟳ |
| the geometry cache (`geometryCache.ts`) | one neuron's skeleton or mesh | source, dataset, id, and whatever else decides the geometry | the session | Clear Cache |

**The third exists because the first two cannot help each other.** A morphology node's key folds
in its upstream *provenance*, so it re-runs whenever anything about its Neurons input changes —
and re-running means re-downloading. Probed on a 12-neuron scene: widening a type pattern from
`LC4` to `LC4|LC6` asked the source for 21 ids of which 12 had just been fetched, and an upstream
Filter edit that kept every row asked for the same 12 again, byte-identical list and all.

**The graph is not wrong, so the fix is not in the graph.** Re-running is what a changed input
means, and keying a node on the *content* of its input rather than its provenance is exactly what
invariant 4 forbids — it would mean hashing every row of every table on every edit, which is the
cost that rule exists to avoid. What is wasteful is not the re-run; it is the re-download inside
it. So the memo sits below the `DataSource` seam, where the unit is a neuron rather than a node:
the node still re-runs, still asks for the whole list, and the source answers the part it holds.
Nothing about the graph changes — no port, no param, no scheduler rule, nothing in a saved file.

**Holding it is nearly free, and that is a property rather than a hope.** The cache holds the
*same typed arrays* the values hold, so while a scene is live its geometry is referenced by the
result cache anyway and the marginal memory is only for geometry no longer referenced anywhere.
That is safe because the transform nodes copy rather than write through (`transformOps.ts` builds
a `new Float32Array`) — an invariant this depends on, and one `geometryCache.test.ts` pins.

**The key is the caller's to compose, and for meshes it is not just the id.** `chooseLod` picks
one detail level for the whole batch against the triangle budget, so the same body is legitimately
two different meshes and the level goes in the key — which also means growing a set past a budget
boundary re-reads everything, honestly. CAVE's decimation grid is the same story. A skeleton has
no such parameter, so skeletons hit whenever the sets overlap. **Manifests are cached separately**
and are level-*independent*, which is what makes the level decision itself cost nothing.

**Not persistent, deliberately.** Skeletons and meshes are tens to hundreds of megabytes of typed
array, and a structured clone of that on every run has a cost of its own; the pain being fixed is
within-session iteration. `cache.ts` remains the persistent layer, for tables.

**Not a freshness policy either.** A neuPrint body id and a CAVE root id name immutable geometry —
an edit mints a new root id — so there is nothing to go stale. A CATMAID skeleton is live tracing
data and is held on the same terms by decision, which is why `neuron.skeletons` and `neuron.meshes`
declare `dataCache`: Clear Cache is the way back, and `GeometryRequest.onFetched` puts
`cached 12m ago ⟳` in the card's foot so nothing ages silently.

**Only the result cache used to be reachable, and the menu claimed otherwise.** The item read
`Invalidate cache` with a tooltip saying "forcing a re-fetch" — and on a FlyTable node the card
cleared, the node re-ran, and the answer came back in milliseconds with the same 79 MB of rows,
because the table cache is keyed by the ref and kept for a month. A control that looks like it
worked.

**`ctx.refresh` is what crosses the gap.** `Scheduler.clearNodeCache` invalidates the result *and*
arms a flag; `evaluate` reads it and passes it down to whatever fetches. Session state, never the
document — it must not be saved, must not travel to whoever you send the file to, and must not
take part in the provenance key.

Two things about *when* it is spent. It goes at **execution**, not at the top of a run: an
expensive node is deferred by the cheap pass, which fires on every keystroke, so a flag cleared
there would be gone before the node ever had its chance — Clear Cache would work or not depending
on whether anybody typed in between. And `pruneCache` drops it with its node, since ids are reused
across loads and a stranded request would be spent by whatever took the id.

**`NodeDefinition.dataCache` is one declaration meaning two things**: the button appears, and
`evaluate` honours `ctx.refresh`. It says nothing about *which* cache — the annotation nodes mean
the IndexedDB table store, the morphology nodes mean the session geometry cache — only that there
is one behind this node and the button reaches it. Paired deliberately — a node offering the
button and ignoring the flag is exactly the control-that-does-nothing this replaced, and a button
on a Filter would promise a re-fetch with no fetch behind it.

**The card says how old the data is, and the label is the control.** `cached 3d ago ⟳` in the
foot of any node that reported a fetch, clearing that node's data cache and running it. A passive
badge would leave the obvious next act — a fresher copy — two gestures away in a menu, and what
somebody wants on reading "3d" is not to be told again.

**Shown whenever there is an age, not only when it is large.** `cached 0s ago` is exactly as
informative as it sounds, and it is what makes the number believable the day it reads `28d` — the
rule that keeps geometry units printed when they are the expected ones, and the matched half of
`unmatchedLabels` on screen. There is no threshold and no confirm.

**The age is reported, not derived, and that is forced.** A cache hit and a fresh read are
indistinguishable from the rows, so `ctx.reportFetched(at)` carries it: `cacheGetEntry` hands
`savedAt` to `loadCachedTable`, which calls `spec.onFetched` — the `onProgress` idiom, because
every caller wants the table and only one wants the age, so widening the return type would edit
six call sites to serve one. The oldest report of a run wins, so a node making several fetches
says how stale its worst is.

**It lives in the scheduler's `CacheEntry`, not in `NodeRunInfo`**, and that is the whole of why
it works. A second Run over an unchanged graph re-executes nothing, so a run-time report would be
gone while the stale table it described stayed on screen — the failure CLAUDE.md already records
as "there is no channel from `evaluate` to a badge that survives a result being restored from
cache". This is that channel, and it took a second consumer to justify it: an age is the one thing
that genuinely cannot be derived from the result, since it is not in the rows.

`formatAge` is deliberately **not** `formatDuration`. That one measures how long a run took and is
written for the millisecond end (`<1ms`, `142ms`, `2.4s`); this answers a different question and
rounds rather than refining — nobody deciding whether to re-read a base is served by `2.7d`. It
**floors**, so nothing is ever reported as older than it is: `23h` stays `23h` until it really is
a day.

### The dataset card asks the cache instead, because it fetched none of it

`cached 3d ago ⟳` on a dataset node, and everything above about *where the number comes from* is
inverted. A dataset node's `evaluate` resolves metadata: a listing, a version, a label. It never
touches the thing that goes stale. **The neuron index is downloaded a card away** — by Explore, by
Dataset Summary, by Neuron Profile — under `neuron-index:{source}:{dataset}` and kept for a month,
and `ctx.reportFetched` cannot carry an age across that gap because no fetch happened here.

**Why a month is the wrong number for some datasets and there is nothing to fix.** It is right for
a released connectome: neuPrint publishes a new dataset *version* rather than editing one in place,
so the expiry is about eventually noticing a re-release. It is wrong for one still being proofread,
where a re-release lands in minutes to days — and the only symptom is a count that quietly does not
change. Shortening the expiry would make every static dataset re-download 26 MB for nothing. So the
answer is not a better default; it is saying which copy you are looking at.

So this variant **looks**, and looking costs something reporting does not:

- **The age is a peek, not a read.** IndexedDB has no partial read — `store.get` deserialises the
  whole structured clone — so a card asking only *when* would pay 26 MB per card per session for
  one number. `cache.ts` keeps a second object store holding nothing but `{savedAt, fingerprint}`,
  written beside the value; `cachePeek` reads that. Entries written before that store existed have
  no record in it, so the peek falls back to one full read and **leaves a sidecar behind** — paid
  once per key, and nothing has to be re-downloaded to get there.
- **It must notice a download it did not start.** `onCacheChange` announces every write and delete,
  and the card re-peeks. Without it the age would be right on mount and wrong from the first Run,
  which is worse than absent — a number that is *sometimes* maintained is one nobody can use.
- **It must not fetch to find out.** Mounting `useNeuronIndex` starts a download, and a canvas
  holds several dataset cards; that is why `useNeuronIndexState` exists, subscribing to the shared
  entry without asking for one.

**The ⟳ drops everything keyed to the dataset**, which is what `datasetCacheKey` is for: one
convention — `kind:sourceId:datasetId[:variant]` — so the inverse question has a single answer.
Clearing only the index would leave ROI outlines traced from the old release and a summary counting
the old neurons, behind a card claiming it had cleared the cache. `kind` may not contain a colon,
and that is load-bearing rather than tidy: a neuPrint dataset id is itself `hemibrain:v1.2.1`, so
the scope is matched as a whole segment and never by prefix — otherwise `hemibrain:v1.2` drops
`v1.2.1`'s 26 MB. Then it re-downloads, through the same shared `reloadNeuronIndex` any Explore
card on that dataset is watching, and says `loading neurons` in the foot while it runs.

**Not the geometry cache**, and that is not an oversight — it is in memory for the session and
holds geometry named by an immutable id, per the section above.

**`no cache` is text, not a button.** Everything else here is an affordance because somebody
reading an age wants a fresher copy; nobody reading `no cache` on a card they have just dropped
onto the canvas wants a 26 MB download, and a ⟳ under the pointer is how they would get one by
accident. It is still *shown*, for the same reason `cached 0s ago` is.

**It replaced the annotation nodes' `refresh` nonce.** A nonce works, and invariant 4 is why they
exist at all; what it costs is that re-fetching becomes an **edit** — in the provenance key, in the
saved file, and carried to whoever you send the graph to — and that every node wanting the ability
grows its own param. `dataset.*` and `core.tableFromUrl` still carry theirs; they are the obvious
next candidates, and `refreshParam` stays for them.

## A partial result, while the node is still running

`ctx.publish(outputs)` puts a half-finished value on a node's output port without the node having
returned. `neuron.skeletons` and `neuron.meshes` use it, so a 3D scene fills in as bodies land
instead of appearing all at once at the end. Measured on 60 hand-traced FAFB skeletons through
CATMAID: the scene went 7 → 10 → 19 → 22 → 29 → 38 → 45 → 55 → 60 over the 2.5 s the fetch took,
where before it was 4.5 s of nothing and then everything.

**Nothing downstream re-runs.** That is what makes it cheap enough to do four times a second, and
it works because the 3D viewer draws from its **inputs** rather than from its own output —
`ValuePreview`'s `out.viewer3d` branch reads `inputValues`. The value on the upstream port *is*
the scene, so growing it is the whole mechanism. No re-entrant scheduler pass, no second
evaluation, nothing new in a saved file.

Three things had to be true, and each was a separate bug waiting:

**A preview is not a cache entry.** It lives in `Scheduler.previews`, read *before* the cache by
`output`/`outputs` and dropped the moment the node settles — onto the real result, or onto
nothing. A partial stored under the node's provenance key would be the answer *for that key*
(invariant 4), so a run cancelled at body 250 of 300 would leave a scene that looks complete and
that no later run would even be scheduled to fix. The geometry is still in `geometryCache`, so
dropping it costs a redraw rather than a re-download.

**`onPreview` is its own host hook, not `onStateChange`.** A state change moves a badge, and a
card subscribes to it through its *own* node's state; a preview changes what is on somebody
else's card. `void s.runVersion` inside a selector subscribes to nothing on its own — zustand
compares what the selector *returns* — so the 3D View card, whose own output and state are both
unchanged while its upstream fills in, would never re-render. `previewVersion` is selected
directly, as the primitive invariant 7 requires — and returned as a constant for anything that is
not a viewer, so the repaint cost tracks the scene rather than the size of the graph.

**The viewer branch sits above `ValuePreview`'s `!value` guard**, on `out.rois`' terms. This
node's own output is the selection table, empty until it evaluates — one whole scheduler step
after the geometry arrived. Below the guard the card could only ever draw a finished run. It is
gated on an input actually being present, so a graph that has never run still says "No result
yet" instead of standing up a WebGL context to draw an empty box.

Rate-limiting lives in one place, `PUBLISH_INTERVAL_MS` in `geometryCache.ts`, because the cost
is not local: every publish repaints every viewer card, and a skeleton channel rebuilds its one
merged vertex buffer each time. Leading edge only and no timer — the complete answer is the
trailing edge. It is per fetch rather than global, which is only safe because the scheduler runs
nodes one at a time; two morphology nodes in a graph do not publish concurrently.

**Re-assembling a partial has to be cheap, or the feature pays for itself twice.** Every publish
rebuilds the whole value from every body that has arrived, so anything derived per body was being
recomputed a dozen times over a fetch — `cableLength` (one `Math.hypot` per skeleton node),
`boundsOf` (a pass over every vertex) and the skeleton segment count. All three are now memoised
on the geometry's identity through a `WeakMap`, which is sound for the same reason
`geometryCache` can hand back the array it holds rather than a copy: transforms build a new
`Float32Array` instead of writing through their input.

## Auto-run

A checkbox beside Run. On, every change re-runs the **whole** graph, expensive nodes included;
off (the default), the existing hybrid model applies. Persisted in `localStorage`
(`coda.autorun.v1`), so an expensive workflow can be left on manual.

**Off is a safety default, not a taste one.** Expensive nodes hit a shared production Neo4j, and
invariant 6 exists precisely so a reactive editor does not fire a query per keystroke. Auto-run
is an explicit opt-out of that.

**One timer, not two.** With auto-run on, `afterGraphChange` schedules _only_ the full pass, at
`AUTO_FULL_RUN_DELAY_MS` (700ms, against 180ms for the cheap pass). Scheduling the cheap pass as
well would have it supersede an in-flight full run — `scheduler.run` aborts whatever is running —
so a slow query would be cancelled and restarted by the very keystroke meant to refine it. The
cost is that cheap edits also wait 700ms while auto-run is on; the alternative is thrashing.

**`runFull` carries a token, and that is load-bearing.** `scheduler.run` supersedes an in-flight
run by aborting it, so the superseded call's `finally` lands _after_ the newer one has set
`busy: true`. Clearing `busy` there leaves the UI idle-looking — no Cancel button, an enabled Run
— with a run still going. Only the newest token writes `busy` or `lastRun`. This also fixes the
same latent race in a fast double-click on Run, which predates auto-run.

Switching it on runs immediately rather than waiting for the next edit: a stale graph that stays
stale until you touch something reads as the setting not working.

Testing note: the Filter node is `cheap`, so editing it proves nothing about auto-run — the
ordinary pass re-runs it either way. Only an expensive node's param distinguishes the modes.
And a `typePattern` matching nothing makes Connectivity error ("No neuronIds…") and blocks
everything downstream, so a test that waits for zero stale nodes will hang on it.

## Variadic ports — a port set sized by a param

Most nodes declare a fixed list of ports. A few cannot: `Match Cell Types` maps cell types
across N connectomes, and **chaining two-input mappers is not the same computation** — with
FlyWire left and right, `AOTU008a` and `AOTU008b` stay distinct; add the hemibrain and they must
collapse into `AOTU008`. A node that let you chain would offer a plausible wrong answer with
nothing on screen to say so. See [comparative.md](comparative.md).

So `NodeDefinition.inputs` and `.outputs` are lists of **slots**, and a slot is either a
`PortDef` or a `PortGroupDef` — a run of ports repeated as many times as one of the node's
params says. `core/ports.ts` is the one expansion; nothing iterates `def.inputs` directly.

**The count is a param, not a function of the wires.** A port set derived from which sockets
happen to be connected is not saved anywhere, cannot be undone, and never reaches the provenance
key. As an ordinary `int` param it is all three for free, it renders as a number field with no
new widget, and invariant 4 keeps a run keyed by it. **The param also carries the range** — a
group has no `min`/`max` of its own, so the spinner the user turns and the expansion cannot read
two independently written pairs of numbers.

**`params` is required on the first resolver, and the type-level reading has its own name.** An
optional argument is how the first two rows of the table below quietly become one call: a caller
holding a node omits `node.params`, type-checks, runs, and is wrong only above the default arity
— which is to say, wrong exactly where the feature exists. That is not hypothetical; `help/figures.ts`
types its params as `Record<string, string>`, which is assignable to `ParamValues`, so it would
have drawn default-arity sockets while looking arity-aware.

**Ports are variadic; params are not.** A node wanting a setting per repeat declares them to
`max` and hides the surplus with `visibleIf` — hidden params are excluded from the provenance
key, so a picker sitting past the current count cannot stale a run. Making params variadic too
would have meant a second, parallel expansion in `normalizeParams`, the inspector and every
column resolver, for no case that needs it.

**Declarative, not a `(params) => PortDef[]` callback**, and that is the load-bearing choice.
Two questions are asked about ports with no node and therefore no params in hand:
`typesWithReferenceInputs` scans the whole registry to decide whether a graph can contain a
reference edge at all, and `isReferencePort` answers about a port id mid link-drag. A callback is
opaque to both. A spec can be expanded at `max` instead, which covers every id that could ever
exist — hence three named resolvers rather than one with an optional argument:

| | for | resolves counts from |
| --- | --- | --- |
| `inputPorts(def, params)` | inference, scheduler, card, inspector, exporters | the node's own params |
| `defaultInputPorts(def)` | palette, node browser, thumbnail, node guide, help figures | the param's declared default — a *fresh* node's shape |
| `allInputPorts(def)` | `isReferencePort`, `typesWithReferenceInputs`, the emitter port audit | `max` — every id the type could ever have |

A definition with no groups gets its **own array back**, allocating nothing: `inferGraph` walks
every node twice per keystroke and `wouldCreateCycle` runs once per pointer move of a link drag.
A definition is frozen once `registerNode` returns, so "has this any groups?", "what is every
port at max?" and each group's range are memoised in a `WeakMap` keyed by the definition — no
invalidation needed, the same reasoning as `typesWithReferenceInputs` one layer up.

**Two places an arity that shrinks leaves an edge pointing at nothing**, and neither reports
itself. Every walk looks edges up *by* port key, so an edge on an id nobody asks about is never
read — it sits in the document, survives a save/load round trip, and reappears as a live wire
carrying its old source the moment the count goes back up.

- Writing params at all: the prune hangs off **`updateNode`**, the generic node patch, not off
  `setNodeParam` — which is one caller of it. The assistant writes params straight through
  `updateNode`, so hanging it on the specialised setter would have left an assistant plan that
  lowers a count with edges on ports that are no longer drawn. Same graph transform as the patch,
  so the two undo as one step; `pruneGroups` is the precedent — a mutation owns the derived
  structure it invalidates.
- Loading a file: `deserializeGraph` now resolves **both** handles of every edge against the
  node's actual ports and drops what does not exist, with a warning naming the node. This
  caught two long-standing fixtures wiring handles that were never real (`sourceHandle: 'table'`
  on a node publishing `out`, `'out'` on one publishing `neurons`) — edges that had been inert
  since they were written. The `?? 'out'` / `?? 'in'` fallbacks for files old enough to omit a
  handle now heal to the node's *sole* port instead, which is what those defaults were reaching
  for and were wrong about for any node whose one port is named otherwise.

**`ctx.inputPorts()` / `ctx.outputPorts()`** on both the infer and eval contexts, so a variadic
node's body never rebuilds ids by concatenating a template and an index. That would be a second
spelling of the expansion rule, once per node, each free to disagree about whether the index is
0-based. `ResolvedPort.group` carries `{ repeat, index }`, so a body reads its per-repeat params
off the port rather than the other way round.

**Registration refuses** a `repeat` naming no param, a non-`int` one, one declaring no
`min`/`max`, a default outside that range, a `min` below 1, a group repeating no ports, and any
two ports that collide **at max**. It also refuses a repeat param that is `presentational` or
carries a `visibleIf`: `normalizeParams` drops both from the provenance key — correctly, for
colour scales and switched-off branches — and a *count* excluded from that key means changing a
node's arity does not re-key it, so the scheduler serves a cached result missing the outputs the
new ports were added for. The port set is the one thing a param can change that the cache cannot
otherwise see — checked there rather
than at the default, because a collision that only appears at arity five is still a collision
and would otherwise ship. All five fail silently at runtime otherwise; the `loop`/`loopPlan`
pairing beside it is refused for the same reason.

**`autoWireDataset` fills at most one port per group.** Pointing every Dataset input of a
comparison node at the graph's single dataset node wires it to compare a connectome with itself
— a graph that runs, produces an answer, and means nothing.


## Reference edges — a port that names a node

`PortDef.reference` marks an **input that names a node rather than consuming its output**. It
creates no ordering dependency: excluded from `topoSort` and from `wouldCreateCycle`, never waited
on by the scheduler.

It exists for one wiring, and that wiring is a node's own documented use: `Dataset → CAVE table →
Dataset`, a datastack's annotation table handed back to that datastack as its labels. Two edges
between one pair in opposite directions, which at *node* granularity `topoSort` reads as a cycle —
both cards went dark with no result and nothing naming the cause. At *port* granularity there is
no cycle at all, and that is the whole insight: `CAVE table`'s output needs the annotation table,
not the dataset ref; the Dataset's output needs the annotations schema, not `CAVE table`'s ref. A
node cannot half-run, so the sort cannot see it.

**What makes it sound is a property of the upstream node, not a promise from the downstream one.**
A dataset node's identity is a function of its params alone —
`T.dataset(family.sourceId, resolveDatasetId(family, params.version), annotationSchemaFrom(…))`,
where only the third argument comes from an input. So a reference reads something knowable without
running, or even inferring, anything downstream. **Check that before marking a new port
`reference`**; it is the condition the whole mechanism rests on.

Five places implement it, and each was mutation-checked because every failure here is silent:

- **A registry-level short-circuit first.** Exactly one node type declares a reference input, so
  `typesWithReferenceInputs()` lets every walk ask "could this graph hold one at all?" without
  touching an edge — and on every graph without one, `dataflowEdges` returns `graph.edges` itself
  and allocates nothing. Measured 1.4 µs → 0.13 µs; `topoSort` runs twice per keystroke and
  `wouldCreateCycle` once per pointer move of a link drag. The memo is **cleared by
  `registerNode`** rather than assumed fixed, because a type registered afterwards would otherwise
  be invisible and the round trip would read as a cycle again — pinned by a test that warms the
  memo *before* registering.
- **`dataflowEdges` in `graph.ts`, and nowhere else.** One filter, inside the one index from which
  `topoSort` derives *both* the indegree count and its decrement — the arrangement that function's
  own note demands, after the bug where the two came from different places and a target joined
  twice never reached zero. Filtering anywhere else would bring that back wearing a reference's
  clothes.
- **`wouldCreateCycle` takes the target handle**, because the wire *being drawn* can itself be a
  reference and then can never close a loop. Without it the editor refuses exactly the wiring this
  exists to allow.
- **`checkConnection` no longer walks its own edges.** It had a second reachability implementation
  over `graph.edges` — one statement of a question `wouldCreateCycle` already answered — and the
  two had to be found together: one knew about references and the other refused every wire.
- **Inference resolves a reference type in isolation**: the source node's `inferOutputs` with *no
  inputs at all*. It cannot recurse, so the walk terminates, and for a dataset it yields exactly
  the identity without the annotations schema — the honest answer as well as the terminating one,
  since a node cannot read the annotations it is itself about to supply. Through `outputTypesFor`,
  which the main walk also uses, so "a reference is the same node inferred with no inputs" is
  literally true rather than a second implementation that resembles it: the two had already parted
  company on the merge rule (`if (type)` against `?? declared`) and on whether a throw becomes an
  issue.
- **The scheduler neither waits nor keys on the upstream.** `evaluate` is handed the value
  `datasetIdentity(type)` builds, and the provenance takes `referenceKey(type)` in place of the
  upstream node's key — which it *must*, since that node is outside the order and its key may not
  exist yet. It is also the better key: changing the dataset's version re-keys the reader,
  changing its annotations does not, and the reader never sees them. Both are single functions for
  `upstreamKey`'s stated reason — the key is read by the two consumers that must not disagree, and
  it was written out twice at first. `datasetIdentity` lives beside `DatasetValue` in `values.ts`
  rather than in the scheduler, because it is the type→value projection and it is **partial**: no
  annotations, and `label` is the dataset id rather than the human name an ordinary wire carries.

**Deliberately narrow: a Dataset socket that takes the identity only, not a general information
edge.** Synthesising a value from a type is defensible exactly because a dataset's identity *is*
its type; there is no second kind asking, and a general mechanism would have to answer that
question for every one of them.

The canvas draws it **dotted** — a wire already wears the colour of the data flowing through it,
so a hue would read as a type, where what this has to say is that nothing flows.

**Writing the graph out wants the opposite order, and both exporters take it.** `topoSort` leaves
references out because the reader waits on nothing; a *cell* that names the referenced node needs
that node's own line to exist already. `exportOrder` in `src/export/order.ts` hoists them and both
walks call it — one function rather than two lines copied into each, and in the layer whose
vocabulary the rationale is written in. The copy doctrine protects the *assembly* walk (chunks,
variable naming, unwired-versus-blocked); an ordering rule with no language in it is the same
class as `canExport.ts`'s refusal policy, which both surfaces already share.
Without it —
without it the reader is classified `blocked by "Dataset"` and emits a TODO that is false and
cascades to everything downstream. The condition that makes the hoist valid is the same one that
makes references sound: **a referenced node's cell must be writable from its params alone**. A
dataset's is — a `Client(…)` naming a datastack and a version — which is why it can be lifted
above the annotations wired into it, and it is the thing to check when writing an emitter for a
node anything references.

Unreachable today, and deliberately built anyway: every CAVE node sits in `NO_EMITTER` and a CAVE
dataset refuses export outright, so the only reference port in the tree is on a node with no
emitter. The day a caveclient emitter is written it would fire, and it fires as a *plausible*
TODO rather than as an error. `reference.test.ts` covers the ordering; the end-to-end case has
nothing to exercise it with until that emitter exists.
