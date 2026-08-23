# Core mechanics

The scheduler-adjacent rules: caching, auto-run, and reference edges.

Moved verbatim out of `CLAUDE.md`.


## Two caches, and the two controls that clear them

`Invalidate Results` and `Clear Cache`, in the node's context menu and side by side in the
inspector. They are different layers and the difference is not cosmetic:

| | what it holds | keyed by | cleared by |
| --- | --- | --- | --- |
| the scheduler's result cache | what `evaluate` returned | provenance — `hash(type, params, upstream)` | Invalidate Results |
| the data cache (`loadCachedTable` → IndexedDB) | what a *server* returned | what was fetched | Clear Cache |

**Only the first was reachable, and the menu claimed otherwise.** The item read `Invalidate
cache` with a tooltip saying "forcing a re-fetch" — and on a FlyTable node the card cleared, the
node re-ran, and the answer came back in milliseconds with the same 79 MB of rows, because the
second layer is keyed by the ref and kept for a month. A control that looks like it worked.

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
`evaluate` honours `ctx.refresh`. Paired deliberately — a node offering the button and ignoring
the flag is exactly the control-that-does-nothing this replaced, and a button on a Filter would
promise a re-fetch with no fetch behind it.

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

**It replaced the annotation nodes' `refresh` nonce.** A nonce works, and invariant 4 is why they
exist at all; what it costs is that re-fetching becomes an **edit** — in the provenance key, in the
saved file, and carried to whoever you send the graph to — and that every node wanting the ability
grows its own param. `dataset.*` and `core.tableFromUrl` still carry theirs; they are the obvious
next candidates, and `refreshParam` stays for them.

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
