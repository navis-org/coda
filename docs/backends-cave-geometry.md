# Backends: CAVE meshes and skeletons

CAVE geometry: the flat segmentation, thumbnails, graphene meshes and their decimation, and the
three routes to a skeleton. The rest of CAVE is in [backends-cave.md](backends-cave.md).
[backends.md](backends.md) holds what all of them share — the geometry cache and streaming.

### The flat segmentation beside a materialization, which CAVE does not mention

A datastack's `segmentation_source` is `graphene://` and has to be: a root id is a *dynamic*
agglomeration of supervoxels, which is what the chunkedgraph exists to serve. The cost is that
**graphene has no level of detail** — a verified mesh manifest lists supervoxel fragments at full
resolution — so one FlyWire neuron is 492 range requests and ~1.2 MB, `decimateMesh` is what makes
a scene of them survivable, and there is nothing cheap enough to draw a list of thumbnails from.

A *released* materialization is frozen, though, and its publishers usually also flatten it into an
ordinary precomputed bucket with a pyramid in it. **Nothing in CAVE's metadata says so**, which is
why `DatastackSpec.flat` names them by hand, keyed by version:

```ts
flat: {
  630: 'precomputed://gs://flywire_v141_m630',
  783: 'precomputed://gs://flywire_v141_m783',
}
```

Measured over eight v783 proofread neurons, against the graphene route for the same ids:

| | graphene | `gs://flywire_v141_m783` |
| --- | --- | --- |
| requests per neuron | 10–130 median, past 600 | 2 |
| levels | 1 | 3–5 |
| coarsest level | — | one fragment, 73 kB – 1.44 MB |
| finest level | 0.5 – 3.9 MB | 0.3 – 10.8 MB |
| `triangleBudget` honoured by | decimation, exactly | choosing a level, overshooting at the floor |

Four things this is, and each is a decision rather than a consequence.

**Keyed by version, sparsely, and an absent entry is the ordinary case.** A flat bucket holds the
root ids that were current when it was written, so v630's cannot answer for a v783 id. FlyWire
published one for each of its two; BANC published one for 888 and none for 626. Where there is no
entry the graphene route runs, and that route answers for any root id ever minted — which is why
the fallback is not a degradation.

**A pyramid, not a bucket, and BANC's is deliberately not listed.**
`gs://lee-lab_brain-and-nerve-cord-fly-connectome/neuron_meshes/meshes` publishes no `info`, which
by convention means `neuroglancer_legacy_mesh`: one level, full resolution. Measured on two v888
neurons, **28.4 MB and 60.8 MB** apiece — against ~200 kB of Draco for the same neuron through
graphene, whose meshing agglomerates across chunkedgraph layers 2–6 rather than serving leaves.
There is no level to draw a thumbnail from and the Meshes node would be worse off, so
`flatMeshDir` requires `multilod-draco` and falls back rather than reporting a better source than
it has.

**This is one of the two things that make `fetchCoarseGeometry` possible**, and CAVE was the
reason the Explore Dataset list showed a placeholder in every row. `fetchCoarseMesh` is shared
with neuPrint — `triangleBudget: 1`, which no level can meet, so `chooseLod` answers with the
coarsest, and `THUMBNAIL_MAX_BYTES` turns down a single pathological body off the manifest at no
download cost. The other route is the level-2 chunk graph, below, which is what a datastack with
no flat bucket draws from.

**Nanometres with no conversion, and that is measured on both halves rather than assumed.** The
mesh bounding box for `720575940633370649` is x 682,703–723,512 nm; the same neuron's published
skeleton is 682,704–723,568. The mesh `info`'s own `transform` is what does it, and
`fragmentTransform` already applies it. The live suite asserts the pair, because a missing
conversion here is a scene sitting a whole factor away from the neurons beside it with nothing
failing.

### A thumbnail from the chunk graph, where there is no mesh cheap enough to draw

A datastack with only its `graphene://` segmentation has **no cheap mesh at any level** — the
cheapest mesh is the only mesh — so a page of 25 rows would be tens of megabytes, which is exactly
what `DataSource.fetchCoarseGeometry` says to answer `undefined` for. That left BANC, MICrONS and
every other chunkedgraph datastack with a placeholder in every row.

The level-2 chunk graph is the way out, and it is already built: `readL2Skeletons` for one neuron,
two small requests, a few hundred chunks with a representative coordinate each. `l2SourceFor` is
the same gate the Skeletons node uses, so a datastack with no cache still answers `undefined`.

**Where the skeleton service already holds the neuron, it answers the thumbnail instead**, and on
minnie65 that is the whole of the hover preview's wait. Its proofread neurons are big — 6k–21k
level-2 chunks — so the chunk graph alone is 6–8 s and the route was 11–13 s a neuron, paid once
for the tile and again for the preview. The service's cached skeleton is a 0.6 s `exists` and a
~1 s download, draws the same thumbnail (it is generated from this same cache) with a radius on
every vertex, and measured through `CaveSource` at 0.8–2.0 s for the tile and 0.7–0.9 s for the
preview. Two rules keep it from costing anything elsewhere. The thumbnail's verdict on a service
is **its own and one-sided** (`serviceThumbnail`): a service that misses before it has ever
answered is not asked again this session, so BANC pays one `exists` rather than one a row; and it
passes `learn: false`, because one uncached neuron is no evidence about a cache and must not set
the `barren` flag that sends the Skeletons node's `automatic` to the chunk graph.

So `CoarseGeometry` is a **union** — `{ kind: 'mesh' }` or `{ kind: 'skeleton' } & SkeletonGeometry`
— rather than one shape both routes have to fit. Making a source fake the other one means meshing
a skeleton or decimating a mesh into a tree, which is work done to satisfy a type rather than to
draw a picture. The skeleton arm is `SkeletonGeometry` exactly, so the L2 reader's output needs no
conversion at all; `kind` is required on both arms, because a source that forgot it would be a
silent fall-through to the mesh branch and a blank tile. The rasteriser that consumes it is in
[widgets-explore.md](widgets-explore.md), including where `STROKE_FRACTION` comes from.

**What it costs is one neuron's worth of batching, knowingly.** `readL2Skeletons` pools chunk ids
across a whole request and reads their coordinates in a handful of calls, which is what makes a
hundred skeletons a hundred graph reads plus about three attribute reads rather than two hundred
round trips. `CoarseGeometryRequest` is one neuron, so a page of 25 gives that up: 25 chunk-graph
reads plus 25 attribute reads, instead of 25 plus about one. Widening the seam to a page would mean a batching protocol between the component and every
source, for a picture already gated at four concurrent and cached in IndexedDB after the first
look.

Measured on four BANC v888 neurons: 19, 310, 1,266 and 2,684 chunks, and 0.4–4.0 s apiece for the
graph read.

### A graphene fragment name is an instruction, not a path — and half of it is a `Range` header

A verified graphene manifest mixes two kinds of fragment, and **neither is an object path as
written**:

  - **Frozen**, `~<layer>/<shard>-0.shard:<offset>:<length>`. Every part of that is an
    instruction: the shard file is `<mesh dir>/initial/<layer>/<shard>-0.shard`, and the two
    numbers are a byte range to ask for with `Range`. The leading `~` is a **marker** saying
    "frozen", not a directory. `SHARDED_MESH_DIR` is the literal `"initial"` because that is what
    it is — cloudvolume's `GrapheneMeshMetadata.sharded_mesh_dir` is the same constant, beside
    `unsharded_mesh_dir`, which *is* published in the `info`.
  - **Recently edited**, a plain object under `mesh_metadata.unsharded_mesh_dir` — `"dynamic"` on
    both mosquito and BANC.

`mapWithConcurrency` turns a failed fragment into a dropped one rather than a failure — the rule
that keeps one bad supervoxel out of 492 from taking a neuron down — so getting either half wrong
produces the same symptom, and it is the worst kind: **a mesh, drawn in the right place, at the
right scale, that is a fraction of the neuron**, under a green node.

Both halves were wrong at some point, and the second was far worse than the first. Reading the
unsharded ones from the mesh root lost every piece anybody had edited. Reading the *frozen* ones
verbatim — as an object literally called `~3/127630-0.shard:10686716:600`, and in full, the range
never becoming a header — lost everything that had **not** been edited, which is nearly all of it.
Measured on `wclee_aedes_brain`: **449 of 471 fragments gone**, so what reached the scene was the
22 pieces somebody had touched since the freeze. On BANC, 54 of a neuron's fragments.

FlyWire's public segmentation is what hid both. It declares no unsharded directory *and* its
manifests carry no `~` name at all — 136 plain objects under the mesh root for one neuron — so
**the datastack the mesh path was built against exercises neither branch**, and the flat pyramid
means it no longer takes this route anyway.

The consequence for the design: a partial answer that is tolerated has to be **counted**, and this
is the one fan-out in the tree *below* the item level. Everywhere else `mapWithConcurrency` runs
over neurons, so a dropped one is an id absent from `cachedGeometry`'s `missing` — a list, which is
strictly better than a count. Fragments are parts of one neuron, so nothing above `readGrapheneMesh`
can see them go.

Three rules came out of getting that reporting right, and the first is the one that is easy to miss.
**The count rides on the value, not on the fetch.** `cachedGeometry` calls `fetch` only for ids it
does not hold, so a counter accumulated across the run reports zero on the second Run beside the
very same short meshes — the tally is cached with each mesh and summed from the result, and reaches
the viewer as `MeshDetail.fragments`, which is the same argument `MeshDetail.decimated` already
makes one notch less severe. **`unaddressable` is split out of `missing`, because only one of them
is a retry**: a 404 may well come back next time, where a name this build cannot parse will parse
the same way forever, and telling somebody to try again is telling them to do the one thing that
cannot work. And **a neuron that failed entirely is a second sentence**, off `fetched.missing`, the
pattern the flat route in the same method already follows — without it the fix would have converted
"a twentieth of the neuron, silently" into "no neuron, silently".

`cave.test.ts` pins the address each name decomposes to, path and inclusive `Range`, plus the
negative that the verbatim name is never requested. A URL is only right if the bucket answers it,
so `live.test.ts` fetches through `fetchMeshes` and asserts `detail.fragments` is `missing: 0` —
which reports 54 against the old rule.

Coalescing the shard reads was measured and rejected: the 449 frozen fragments of one neuron land
in 131 shard files but at scattered offsets, so merging whole files is 3.5 GB (366×) and bridging
gaps under 64 kB buys 449 → 399 requests for an extra megabyte.

### `Detail` and `Downsample`, and why one control could not be both

`GeometryRequest.triangleBudget` has always carried the clause **"a source with one level ignores
it"**. Graphene is that source — supervoxel fragments at one resolution, nothing coarser published
— so the CAVE source honoured the budget the only way it could, by clustering vertices. The result
was one dropdown labelled `Detail` that picked a published level of detail on neuPrint and silently
recomputed the geometry on FlyWire, which is a difference a reader could only find by measuring.

They are two controls now. `Detail` spends a budget among levels a publisher built, and is **drawn
dead where there are none** — `DataSource.meshLevelsFor` is the question, asked through
`meshLevelsOf` and answered from peeks that have already landed, with `undefined` meaning *nobody
has looked* rather than *no levels*. `Downsample` is an explicit factor, defaults to off, applies
to every source, and rides on the request rather than the result so graphene can reduce the
fragments where they already are.

### What stopped a full-resolution neuron drawing was the draw call, not the memory

`Downsample` defaults to **1 — full resolution**, and the two aedes neurons an ordinary workflow
selects drew **nothing at all**. They are 13.1 M and 12.9 M triangles.

The first diagnosis was that 472 MB of typed arrays plus normals was more than the GPU would take.
That was inferred from the symptom and it was **wrong** — and the thing that showed it was wrong is
worth keeping: neuroglancer draws dozens of the same meshes from the same dataset happily. A probe
settled it (`pnpm probe:mesh-upload`): 627 MB uploads fine on an M3 Max, as one buffer set per
neuron *and* as 471 per-fragment sets. Memory was never the limit.

The console said what it actually was:

```
WebGL warning: drawElementsInstanced: Context's max indexCount is 30000000,
but 39429663 requested. [webgl.max-vert-ids-per-draw]
```

**Firefox caps the index values one draw call may ask for at 30,000,000**, and 13.1 M triangles is
39.4 M of them — 31% over. The draw is refused and the geometry silently does not appear. It is a
limit on a *draw*, not on a mesh, which is exactly why neuroglancer is fine: it draws each of the
~471 supervoxel fragments separately where Coda merges them for everything downstream.

The fix is at the draw, not at the geometry. It lives in `ui/viewers/drawLimits.ts` — its own
module, having started in `meshPicking.ts`, which is about raycasting: a renderer limit filed there
is found only by somebody already reading about picking, which is nobody about to add a fourth
geometry channel. That module records which channels can reach the cap (indexed meshes: neuron and
region, which share one leaf) and which cannot (thin lines and points, where memory bites first),
and that fat skeleton lines *might* if Firefox multiplies its count by `instanceCount` — unverified,
written down so the next reader starts from the analysis rather than the symptom.

Concretely: `drawRanges` splits past `MAX_INDICES_PER_DRAW`
(24 M, for headroom and divisible by three so a split never lands inside a triangle), and
`MeshItem` renders one `<mesh>` per range. The pieces **share the `position` and `normal`
attribute objects** — three keys its buffer cache by attribute, so a shared one uploads once
however many geometries name it, and only the index is sliced, as a `subarray` view rather than a
copy. Normals are computed once on a throwaway geometry that is never rendered: three has no
standalone normal pass, and computing them per piece would smooth each as if the others were not
there, leaving a seam down the middle of the neuron. Two neurons of this size cost two extra draw
calls and no extra memory. Normals come from a direct loop over the two arrays rather than
`BufferGeometry.computeVertexNormals()` — **693 ms against 105 ms** on a neuron this size, for
byte-identical output, and it runs in React's render phase, so that was 1.3 s of blocked main
thread before a two-neuron scene painted. Taking the arrays is also what lets the split skip
building a full-resolution geometry purely to throw it away.

Chrome enforces no such cap, which is the other half of why this took three guesses to find: it
reproduces in one browser, on large meshes only, as an absence.

The default stayed at full resolution once the draw was fixed, which is the point: this was a
*drawing* bug, and reducing the geometry by default would have papered over it. `0` remains
available as the automatic setting, worth having for a large set on a source with one level of
detail — and it is a **triangle target** rather than a factor, because no one factor suits two
datasets at once. **Absence is a third answer** (`ParamBase.absentMeans`, `0`): a workflow saved before this
control existed was drawn by a build that reduced graphene meshes out of `triangleBudget`, so
opening it at full resolution would silently make it several times heavier than the picture it was
saved as.

**The factor cannot be calculated, only measured.****The factor cannot be calculated, only measured.** `gridForFactor` inverts `decimateMesh`'s
`0.68 · grid²`, which is a *surface's* law — right for a neuropil shell, wrong for an arbor, which
is a thin tree in a large box. Measured over four real mosquito neurons the exponent runs **1.6 to
2.0** and is a property of the individual neuron, so the model alone asked for half the triangles
of the sparsest and delivered **a twenty-seventh** of them:

| neuron | triangles | ÷2 modelled | ÷2 fitted | ÷4 fitted | ÷16 fitted |
|---|---|---|---|---|---|
| a | 1,817,245 | 2.5× | 1.7× | 3.2× | 12.0× |
| b | 23,851,138 | 2.1× | 1.7× | 3.3× | 11.8× |
| c | 111,673 | **27.5×** | 2.0× | 3.3× | 12.3× |
| d | 1,459,947 | 6.8× | 1.9× | 3.4× | 11.6× |

The contract is closed at the **seam**, not at the leaves: `fetchMeshesFor` in `source.ts` is what
the Meshes node calls, and it reduces the geometry itself where a source handed it back untouched
and stamps `MeshDetail.downsample` whichever route ran. Both halves were needed. `MockSource`
already declined the request silently, which is the `triangleBudget` failure repeating inside the
change that was fixing it — a contract stated at a seam and honoured by hand at four leaves. And
all three sources build `detail` only when `lod` is known, so a flat bucket reduced 4× and put
**nothing on screen**: the exact silent-thinning failure `core/values.ts` says the field exists to
prevent, in the case the control was written for.

Two more things the fix needed to be true rather than nearly true. `CaveSource.meshLevelsFor` has
to read **`flatUrlFor`**, which answers with no network: `peekFlat` returns `undefined` both for a
probe in flight and for a bucket that is not there, so taking it at face value meant `false` was
never returned and `Detail` stayed a live three-way choice on graphene — the one source it does
nothing on, and the reason the split exists. And "drawn dead" means **no options**, which is how
`ParamField` already renders a disabled select; one inert-looking entry was the first shape, and a
`select` with a single option is operable, focusable and indistinguishable from a real choice until
you open it.

So the grid is fitted: two counting passes a factor of two apart give the local slope, one full
pass does the work, and a single correction runs from the **result** where the first attempt misses
by more than half a factor — keeping whichever came closer, so a second pass can never make the
answer worse. On these four it never runs. Cost is about 2.5× the unfitted pass (110 ms against
45 ms on a 1.29 M-triangle mesh), against a fetch measured at 1.3 s a neuron.

Two things measured on the probe itself and deliberately **not** done, recorded so they are not
re-derived: fusing the two probes into one walk saves nothing (the walk is 3–4 ms of a 54 ms probe,
the rest is hashing — 54.6 ms against 53.7 ms fused), and **subsampling destroys the slope**, which
is the one thing the probe measures — the grids are deliberately fine enough that occupancy is
near 1, so a stride-k sample divides both counts by about k and the ratio collapses towards 1
(slope 0.86 at full, 0.33 at k=2, 0.02 at k=4), which then goes into `Math.pow(target/guess, 1/slope)`
as an unbounded grid. What would pay is the container — a `Set` of 668k packed keys is ~31 MB of JS
heap and 33 ms against 3 ms for a bitset — and that is left alone as forty lines of hand-rolled
table against ~45 ms on a path whose fetch is 1.3 s a neuron.

Three things that shipped wrong on the way, all of them the same mistake in different clothes —
reasoning where a measurement was available. Targeting **cells** and converting to triangles
through the input's ratio stopped early on a tube, the vertex count landing on target while the
triangle count had barely moved; the fit works in triangles throughout now. Capping the fitted grid
at `gridForFactor(triangles, 1)` looked principled and took neuron **c** straight back to the
model's answer — any ceiling expressible here is derived from the model this exists to correct, so
there is none. And the first test fixture was a sphere at 60×90, which is *already* coarser than
`MIN_DECIMATE_GRID` can touch and saturates at 1.24× whatever is asked; that saturation is real and
a caller meets it on an already-coarse mesh, but it says nothing about the fit.

### A lone neuron does not price a set, and the one you measure is the big one

The cost sentence this fix put on `grapheneMeshes` was built from **one** neuron: the mosquito
body that had just been debugged, 471 fragments and 14.2 MB. From it came "12 seconds and 14 MB a
neuron for a sharded datastack", and from that a card telling somebody fetching 25 mosquito meshes
to expect **five minutes and 350 MB** for a wait that is half a minute and 98 MB. Re-measured over
sets of 25 on three datastacks:

| datastack | layout | fragments/neuron (median) | s/neuron | MB/neuron |
|---|---|---|---|---|
| FlyWire | unsharded | 132 | 1.59 | 0.51 |
| BANC | sharded | 10 | 0.39 | 0.46 |
| mosquito | sharded | 51 | 1.29 | 3.92 |

Three things in that table, and the first two are the reasons the estimate was wrong rather than
merely stale. **The fragment count varies more than a hundredfold within one datastack** —
mosquito's 25 ran from 4 to 608 — so the neuron that gets measured alone is by selection the one
somebody had open, which is a big one; 471 against a median of 51. And **`unsharded_mesh_dir` does
not predict cost in either direction**: that split was reasoned from the *layout* rather than
measured, and the unsharded datastack turns out to be the slowest per neuron of the three while
the two sharded ones differ from each other by 8×. It is gone; there is one figure now, and the
sentence says the spread out loud instead of implying a precision it cannot have.

The third is the general one, and it is why the file header carries the set numbers rather than
the neuron: **a per-neuron constant measured on a lone neuron is latency-bound in a way a set is
not.** The fragment budget is shared (`fragmentConcurrencyFor`), so a set amortises what a single
fetch pays in full — which is also why the one-neuron measurement is still the right fixture for
tuning `FRAGMENT_CONCURRENCY`, where isolating the fan-out is the point.

### Decimating over the fragments, rather than over a copy of them

The fix above made this path matter: before it, 449 of 471 fragments were dropped, so the mesh
being assembled was a twentieth of the size it should have been. With all of them arriving,
`concatMeshes` followed by `decimateMesh` allocates a **second full-resolution copy** of a mesh
that is about to be reduced by two orders of magnitude — 8.0 MB of positions and 15.3 MB of
indices for one FlyWire neuron, beside the fragments it was built from, with `MESH_CONCURRENCY`
neurons in flight. It also spends an index rebase pass, one add and one write per index, 3.8 M of
them for that neuron, renumbering vertices that the very next pass renumbers again.

`decimateParts` clusters over the fragments where they already are, and joins them itself in the
one case where there is nothing to merge — which is what `concatMeshes` moving out of
`precomputed/legacy.ts` into the `src/data/meshParts.ts` leaf bought. It had been sitting in a
`neuroglancer_legacy_mesh` *parser* that fetches over the network, while four of its five importers
were not that format; the misplacement had started to cost something, since a decimator that cannot
join without pulling a network module into a pure-arithmetic one has to return a sentinel and make
every caller write the join out instead. The same move gave the three structurally identical
`{positions, indices}` types — `RawMesh`, `DecodedMesh`, `DecimatedMesh`, plus two anonymous
spellings in `precomputed/index.ts` — one name, `MeshArrays`. The tell that the name was missing was
the signature this change first shipped with: `decimateParts(parts: readonly DecimatedMesh[])`,
taking as *input* the least decimated thing in the system.

Nothing in the clustering needs them adjacent: a vertex's cell comes from the **global** bounding box and the cell size, and
the slot a cell takes comes only from the order vertices are visited in — so walking the parts in
order visits the exact sequence the joined array would have held. **The result is byte-identical**,
which is the whole licence for doing it, so it is asserted rather than argued: `meshDecimate.test.ts`
compares the two routes at four grids over a sphere cut into fragments, and the real mosquito
neuron's 471 fragments were compared once by hand (1,444 vertices, 4,539 triangles, equal array
for array).

`pnpm probe:mesh-decimate` is the measurement, at that neuron's shape and at the grids a triangle
budget actually asks for — computed from `decimateGridFor`, not transcribed, at twenty, five and
one neuron:

| grid | join, then decimate | decimate over parts |
|---|---|---|
| 332  | 31 ms, 47.5 MB | **16 ms, 23.9 MB** |
| 664  | 30 ms, 63.6 MB | **27 ms, 39.9 MB** |
| 1485 | 64 ms, 91.5 MB | **51 ms, 38.5 MB** |

The saving is the joined copy — 23.6 MB, the fixture's own size — at the two coarser grids, and
more at the finest, where the join route's extra buffers outlive more of the call.

**Read that in `arrayBuffers`, not `heapUsed`**, and this is the trap worth keeping: typed arrays
are not on the JS heap. A 100 MB `Float32Array` moves `heapUsed` by 0.5 MB on Node 26 and
`arrayBuffers` by 100. A joined mesh is *entirely* typed arrays, so the first version of this probe
read `heapUsed` and therefore measured everything except the thing the change removes — it printed
a confident 76.7 MB against 49.5 MB whose difference was really its own scratch allocations and GC
timing. Three more things the probe got wrong and had to be measured out of: its 1 ms sampling
interval **could never fire**, since the call it wraps is synchronous; a fixture built from random
indices per fragment produced 817,582 output triangles from 7,066 output vertices, a ratio no
closed surface can have and 130× the real neuron's, which put the cost in an index pass a real mesh
barely pays; and its fragments were scattered through a **cube**, which is the one shape that
leaves the per-axis cell key unexercised. A single reading is also not a number — the same row
measured 111 / 83 / 98 ms — so each column is a median of three, taken per column, because
reporting the fastest run's memory is picking a memory sample at random.

Two things `decimateParts` deliberately does not do. It **does not free each fragment as it goes**,
which would halve the remaining peak again: `parts` is the caller's array, and a reader that quietly
empties its argument is a worse trade than 23 MB. And it **does not fuse the bounds pass into the
clustering pass** — it cannot, since `cell` and the origin are global and a vertex cannot be
assigned before they are known; the bounds pass is about 5% of the call.

### Three routes to a skeleton, and which one answered is the user's to choose

`GeometryRequest.skeletonSource` names one; `DataSource.skeletonSourcesFor` lists what a dataset
has, best first, and is what the Skeletons node's `Source` dropdown is built from. The list and
the preference `fetchSkeletons` applies with nothing chosen are **one statement**, because a
dropdown whose "Automatic (published skeletons)" names a route the fetch would not take is worse
than one that says nothing. `capabilitiesFor`'s `skeletons` is derived from the same list rather
than asked separately, for the same reason: they are two halves of one fact and were one edit
away from a node that refuses while its dropdown offers a route.

CAVE's order is **published release → published bucket → skeleton service → level-2 cache**, and
no datastack has all four. The release is minnie65's alone (below). A route the dataset does not have is an **error, never a substitution** — answering with a
chunk decomposition because the published bucket is absent would silently change every cable
length downstream, under a card still saying "published skeletons".

**Two refusals, and they answer different questions.** `requireSkeletonRoute` in `source.ts` is
the *vocabulary* half — this backend has never had an `l2` route — and every source calls it,
because written per backend it was a rule three of the five sources simply did not implement: a
node pinned to `published` and repointed at a CATMAID project got the tracing, labelled as the
tracing. The per-**dataset** half stays with the source, since only a probe can answer it, and it
names the thing that is missing (which materialization has no flat bucket, that this datastack
declares no service).

### Skeletons come from the level-2 cache, and the capability is per dataset

**A CAVE datastack's skeletons depend on its chunkedgraph, not on the backend**, so
`capabilities.skeletons` — which is per *source* — was telling every FlyWire-production user
something false. `DataSource.capabilitiesFor(datasetId)` is the seam that fixes it: synchronous,
`undefined` meaning "same as the source", read by `sourceSupports` ahead of the source's own
answer. Only CAVE implements it, and only for `skeletons`; the Skeletons node's refusal now says
"This **dataset** has no skeletons".

**The route is the level-2 chunk graph, which is `fafbseg.flywire.get_l2_skeleton()`'s method.**
Two requests per neuron: the graph of which level-2 chunks touch which, then the L2 cache's
`rep_coord_nm` and `max_dt_nm` per chunk. Measured on BANC: five neurons concurrently in 3.2 s —
which is one neuron's latency, since they overlap — and trees of 739, 69 and 2 nodes with radii.

**`attribute_names` is a query parameter, comma-joined**, as `caveclient.l2cache.get_l2data` sends
it. It was in the JSON body for a long time, where the server ignores it without complaint and
answers all eight attributes: on four minnie65 neurons of 8,643–21,693 chunks, 5.2–13.6 MB in
8–19 s against 1.1–2.8 MB in 3–6 s, identical `rep_coord_nm` and `max_dt_nm` either way. Nothing
failed, which is why it survived — the one symptom was every level-2 skeleton being slow.

**The skeleton *service* several datastacks also publish is not used, and that is measured
rather than assumed.** It generates from this same cache, so it covers no datastack the L2 route
does not: `flywire_fafb_public` declares a service and has no cache, which is exactly why its
skeleton cache was found empty in the phase before this. On one BANC neuron the service took
10–45 s to generate against 1.6 s here, and returned 74 vertices against 146 chunks. It is also
blind to `wclee_aedes_brain`, which has a populated cache and publishes no service at all.
`caveclient.l2cache.has_cache()`'s rule is the gate — the table mapping lists the chunkedgraph
tables the cache knows, and membership is the answer — verified against the live refusal
("Dataset flywire_public does not have an L2 Cache") rather than trusted.

Six of the thirteen datastacks have a cache: BANC, FANC production, FlyWire *production*,
minnie65 public, Aedes and zheng_ca3. **`flywire_fafb_public` does not.**

**Which is why there is a second route, and why both are peeked whatever the other says.**
`gs://flywire_v141_m783/skeletons_mip_1` is a `neuroglancer_skeletons` directory with `radius` and
`cross_sectional_area` on every vertex, published beside the materialization and mentioned nowhere
in CAVE's metadata — see *The flat segmentation* above. It is the only skeleton FlyWire has, and
until it was wired in `capabilitiesFor` settled on a confident `false` and the Skeletons node
declined for the whole datastack. `peekFlat` is called before `peekL2Cache` so that its read is
*started* even in the branch where L2 has already answered.

**Published beats built, and they are not the same product.** Measured over ten v783 neurons, a
published skeleton is 14,559 to 338,087 nodes and ~1.8 MB — roughly seventy times an L2 skeleton,
which is one node per chunk. The published one is a better reconstruction and one request per
neuron instead of two; what it costs is memory, which is what `FLAT_SKELETON_WARN` says. In
practice no datastack has both, and that is the same fact twice: FlyWire's skeletons exist
*because* it has no cache to build any from. The preference is written down anyway, because "they
never coexist" is a fact about today's spec table rather than about CAVE.

Four things in the tree building, each a wrong picture if lost. **Chunks with no cache entry are
dropped, and dropped _before_ the walk** — after it they would orphan their children, where
excluding them lets the walk route around through whatever else they touched (`navis.remove_nodes`
reparents for the same reason; doing it up front needs no reparenting). **A breadth-first
spanning forest**, because the L2 graph is undirected and can hold cycles while a skeleton is a
tree — a cycle surviving into `parents` makes every consumer that walks to a root loop forever.
**Each component gets its own root**, so a neuron split by an edit is two trees rather than one
with a fabricated join. And **a single-chunk neuron answers `undefined` before the cache is
asked**, which is `readGrapheneMesh`'s answer to the same shape of question and saves a round
trip on a common case.

**The attributes call is batched across the whole request, and that is the shape of the fetch.**
It is keyed by *table*, not by root id, so the union of every neuron's chunks goes in a handful
of requests however many neurons were asked for — a hundred neurons is a hundred chunk-graph
reads plus about three attribute reads, rather than two hundred round trips. Measured: 1,177
chunks (twelve neurons' worth) answered in **one 1.64 s request**, against roughly that for each
of the twelve separately. The cost is that progress reports in two phases rather than per neuron.

**`L2_CONCURRENCY` is 16, and it is set by correctness rather than by the curve.** Measured
against BANC, 40 neurons: 14.5 s at 8, 4.6–6.0 s at 16, 3.9–4.9 s at 32, 5.2 s at 48 — three
times faster at 16 and flat after. But **past 16 the server starts dropping requests silently**:
two of three runs at 32 returned 38 and 39 skeletons of 40, and one at 48 returned 39, where
every run at 8 and 16 returned all 40. `mapWithConcurrency` turns a failed neuron into an
`undefined` indistinguishable from a neuron that genuinely has no skeleton, so the missing ones
do not announce themselves.

`L2_SKELETON_WARN` is 100 — a count where the mesh control is a *wait* (`MESH_WARN_SECONDS`), because a skeleton is one
chunk-graph read where a graphene mesh is several hundred requests, and far below what a source
publishing ready-made skeletons has anything to say about. It **warns and builds** rather than
refusing: every FlyWire question of any size arrives on this route, so refusing to pay its cost
was refusing the dataset. See [limits.md](limits.md).

**Points come out in visit order, so a parent always precedes its child.** That is the contract
`SkeletonGeometry.parents` states and that `neuprint/decode.ts` does real work to honour;
emitting in chunk-id order would satisfy the type and break every consumer that walks the array
once, the SWC writer included. The test for it uses edges whose *encounter* order differs from
their *visit* order, because on a chain listed front to back the two coincide and a test built on
one passes whichever the code emits.

**`capabilityOf(source, datasetId, key)` is how a capability is read**, never
`source.capabilities[key]` directly. The per-dataset override is useless to a reader that skips
it, and the two halves of a gate usually sit in different layers — `validate` refuses at edit
time and `evaluate` at run time — so a bypassing reader makes them disagree with nothing
type-checking the pair. Six readers did exactly that when the override was introduced; they all
go through the resolver now. `starters.ts` passes no dataset id and gets the source-level answer,
which is honest there: a starter is a node type and some params, and which dataset it resolves to
is not known until the node runs.

**And `capabilityAnywhere(source, key)` is the third reading, which is a different question
rather than a laxer one.** `capabilities` is the floor and `capabilitiesFor` raises it per
dataset; both answer *"can this dataset do X"*, which is what a node in front of one wants —
refusing until a peek says otherwise is what stops a Skeletons run hanging on a datastack with no
route. A surface choosing what to **offer** has no dataset to ask about and wants the ceiling:
*"is X worth offering for this source at all"*. The Workflow Wizard is the caller and was the
occasion — asking the floor with an undefined dataset id hid the two skeleton workflows for every
CAVE family, all three of which have skeletons. `CAVE_CEILING` declares `skeletons` and nothing
else: a key belongs there when *some* dataset can serve it, never when none can, which is why
`paths` stays false at both ends. A separate function rather than a flag on `capabilityOf`,
because that one has about fifteen callers who all want the floor and a name says which question
was asked where an argument puts the wrong answer one typo away.

**The skeleton is coarse and the docstring says so.** One node per level-2 chunk is tens to a few
hundred for a whole neuron, where a traced skeleton is thousands. It is the right shape for
NBLAST, a 3D overview and cable length; it is not a morphometric reconstruction.

### The skeleton service, which is a third route and answers for one datastack

`src/data/cave/skeletonService.ts`. `skeleton_source` is a standard `neuroglancer_skeletons`
precomputed endpoint — its `/info` declares `radius` and `compartment`, which is exactly what
`SkeletonGeometry` wants, and it is CORS-open with `Authorization` in the preflight's
`Allow-Headers` on every deployment probed. So the format side is `precomputed/skeletons.ts`'s
decoder unchanged; everything that is CAVE's is the layer around it.

**Declaring a service and having one are different facts, and that gap is most of the module.**
All three specced datastacks declare one. Asked whether they can answer, on the same afternoon:

| datastack | cached |
| --- | --- |
| `minnie65_public` | 50 of 50 proofread root ids, at every skeleton version |
| `flywire_fafb_public` | 0 of 5, at versions 0 through 4 |
| `brain_and_nerve_cord_public` | 0 of 5, at versions 0 through 4 |

That is the model rather than a coincidence: a generated skeleton exists because somebody asked
for it, and MICrONS asked. Measured on `minnie65_public` root id `864691134884807418` — **7,167
vertices, 186 kB, 1.45 s**, with a radius on each, where the level-2 route answers a few hundred
nodes for the same neuron. So where both exist the service is the better reconstruction and is
preferred; where the cache is empty the fetch has to notice and fall back.

Four rules make that work, and three of them are silent when wrong.

- **`existingSkeletons` is asked before anything is downloaded.** A GET for a root id the cache
  has never seen routes to a *generation*, which was measured at 10–45 s for one neuron. A fetch
  that skipped the check would present as a node that hangs, indistinguishable from a slow
  network. `exists` answers as a **POST** (`{skeleton_version, root_ids}`) — the GET form 502s —
  and it is one request for the whole set, about half a second at fifty ids. Its body is written
  as *text*, because `JSON.stringify` of an eighteen-digit root id as a number is a different
  neuron (invariant 8) — the same splice `is_latest_roots` performs. **A request for one id is
  answered with a bare `true`/`false`, not a one-entry map** (checked live on minnie65). Read as a
  map it has no entries, so one neuron — or a set whose last batch of 500 held one — came back
  "not cached" and marked the datastack `barren`; the fixture stub answered a map for one id too,
  which is how it passed.
- **Nothing here ever asks the service to generate.** The endpoints exist. Queueing a build would
  turn a Skeletons run into a wait of minutes with nothing to say so, and the honest answer is to
  fetch what is there and warn about the rest.
- **`automatic` takes the service only when it covers _every_ neuron asked for.** A partial answer
  topped up from the chunk graph is a scene where cable length means two different things,
  which is worse than the coarse answer taken whole. An explicit choice fetches what exists and
  says how many it could not.
- **A datastack whose service answered for nothing is remembered for the session** (`barren`), so
  BANC does not pay a `exists` round trip on every run. Only `automatic` reads it; somebody who
  picked the service explicitly is entitled to ask again, and a cache that has filled since is
  exactly when that matters.

Two more endpoint notes. The version is the **highest the deployment lists** rather than
caveclient's constant 4: `/skeletoncache/api/versions` answers `[-1, 0, 1, 2, 3, 4]`, and `-1`
means "latest", which is not a number to key a geometry cache on. And MICrONS spells its
`skeleton_source` `precomputed://middleauth+https://…`, where Janelia does not — `middleauth+` is
neuroglancer's way of saying "this needs a token", not part of the address, so
`skeletonServiceUrl` strips both prefixes. A parser handling only one works against two of the
three datastacks and produces a confidently wrong host for the third.

**Synapses are the cheapest capability on this source and needed no new transport.** It is
`queryTable` with a root-id filter — the same call connectivity makes — over `synapses_nt_v1`.
Measured: 14,986 synapses for one neuron in 1.8 s. FlyWire has since moved to
`valid_synapses_nt_v2_view`, through `queryViewChecked`: the same neuron is 9,161 valid synapses
in 1.5 s.

- **`desired_resolution: [1, 1, 1]` is where the nanometres come from**, and it is passed
  explicitly rather than inherited. The table stores **4x4x40 nm voxels**, established by asking
  for both resolutions and watching the values divide by exactly 4, 4 and 40. The server's
  current default for this table happens to *be* nanometres, so omitting it looks perfectly fine
  and would put every synapse a factor out of the scene the day that default moved — with
  nothing failing, because the cloud is internally consistent either way. This is the CAVE-native
  answer to the rule `data/units.ts` implements by scaling.
- **No polarity means two queries, not one.** CAVE has no either-end filter, and an `IN` on both
  columns of one query is an AND — which is the synapses a neuron makes onto *itself*.
- **The cloud is query-relative**, like `fetchConnectivity`: `neuronId` is the end that matched
  the filter and `partnerId` the other, so a Synapses node and a Connectivity node on one neuron
  agree about which id is whose. `polarity` rides in the attribute table because a cloud fetched
  for both ends is two populations in one buffer.

**Meshes work, and cost requests rather than bytes.** A CAVE segmentation is `graphene://`, which
is not a bucket you can read by id: a root id is a dynamic agglomeration, so the fragment list has
to be asked for. `meshes.ts` asks the meshing API, then hands the fragments to
`src/data/precomputed` unchanged — `decodeDracoFragment` and `concatMeshes` needed no edit at all.

**A manifest failure is deliberately *not* swallowed**, which is the opposite of `readLegacyMesh`
beside it. That one reads a static bucket where a 404 genuinely means "this body has no mesh";
this calls an API whose 404 means the *table name* is wrong — the trap named just below. Letting
it throw is what lets `mapWithConcurrency` do its job: one bad neuron still becomes `undefined`
and costs the others nothing, but a systematically broken call fails every neuron and is
rethrown, rather than handing back an empty scene under a green node.

**The bucket mapping is `objectStoreUrl` in `precomputed/transport.ts`**, shared with
`neuprint/nglayers.ts`, which is where the second consumer put it. The first copy here mapped an
*unrecognised* scheme onto the GCS host — a confidently wrong URL rather than a refusal, and 404s
per fragment that read as neurons with no mesh. Not every CAVE datastack is on GCS.

Four things established live, each of which would otherwise be a plausible wrong picture:

- **`verify=True` is not optional.** Without it the manifest answers a single fragment named
  after the root id itself, which does not exist in the bucket — the unverified form is a promise
  about what *would* be meshed rather than a list of files. With it, one FlyWire neuron is **492
  fragments**.
- **The meshing API is keyed by the graphene *table*, not by the datastack**, and on FlyWire
  those are different strings: `flywire_public` against `flywire_fafb_public`. Taking the
  datastack name 404s, so the table is parsed out of the `segmentation_source` URL that named it.
- **Fragments decode straight to world nanometres.** Measured on a real one: x spans
  474,201–474,810. So none of `multires.ts`'s `fragmentOffset`/`fragmentTransform` machinery
  applies, and nothing scales anything — the decoder is called with an identity transform.
- **The bucket is CORS-open** (`storage.googleapis.com`, `access-control-allow-origin: *`), so
  this works from a static deploy with no proxy.

**What it costs, all measured on one neuron:** 492 requests, ~1.2 MB, **13.3 s**, and 1,276,736
triangles before decimation. There is no level of detail to trade against — a graphene manifest
lists supervoxel fragments at full resolution, where neuPrint's multi-resolution meshes answer in
a handful at a chosen LOD. Three constants follow from that, and each is a measurement rather
than a guess:

- **`MESH_WARN_SECONDS` is five minutes**, and the neuron count (150) is derived from it, against the shared `MAX_NEURONS` of 10,000. Said by the
  *source* rather than by the node, because it is a fact about graphene: the same Meshes node
  against neuPrint has nothing to remark on. It reaches the card through
  `GeometryRequest.onWarn` — which is the per-source seam the old note here wanted, arrived at
  from the other direction. It was a refusal until it became clear that twenty is not a
  scientific quantity of neurons; the fetch now says what it will take and goes.
- **`FRAGMENT_CONCURRENCY` is 32.** The work is latency, not bytes — 492 fragments averaging
  2.4 kB — so this is the number that decides the wait: 18.9 s at 12, 13.3 s at 32, 11.3 s at 64.
  Past 32 the gain is small and it is a lot of parallel requests at one host. Measured from Node,
  where nothing caps connections, so a browser will do no better.
- **`MESH_DECIMATE_GRID` is 192**, through the same `decimateMesh` the ROI shells use. Much finer
  than their 32, because a neuron is a thin arbor inside a box the size of the brain and that
  grid would erase it: from 1,276,736 triangles, grid 96 gives 6,308, 192 gives 25,548, 256 gives
  44,091. A full set of 20 is then about half a million triangles, inside the 1.5M budget the
  Meshes node works to. It reduces memory and draw cost, not the wait — the requests are already
  paid by then.

**`fetchCoarseGeometry` does not use this route, and that is the right answer rather than a gap.**
There is no cheap representation among these fragments to draw a thumbnail from, and the
interface's own docstring says an absent one beats quietly downloading full detail to fill a list.
The two routes it does use are the flat pyramid and the level-2 chunk graph, both above.

**The cross-check that ties it together** is in `live.test.ts`: a neuron's mesh has to enclose its
own presynaptic cloud. Neither is scaled by anything here — the fragments arrive in world
nanometres and the synapse query asks for them — so if either assumption were wrong the two boxes
would be a whole factor apart, and nothing else would fail, because each is internally consistent.
Measured: mesh 400,953–603,981 against synapses 402,596–602,328. Same shape as the neuPrint rule
that a mesh bbox must enclose its skeleton's.

**The morphology schema is narrowed rather than canonical.** `neuronId`, `type` and `points`, and
no `instance`, `status`, `size` or `cableLength` — a graphene mesh carries none of them, and a
column that arrives null on every row breaks every picker that believed it.

### A failed lookup is not an answer — three places that said "none" for the session

Found together, from the Cortex gallery drawing half its wall from the level-2 route, unlabelled,
on a datastack whose skeleton service held every cell. Each was the same shape: a lookup that
**failed** was read as a lookup that answered **no**, and the no was kept for the session.

- **`l2TableMapping`** turned any failure — a 5xx, a timeout, a *cancel* — into an empty mapping,
  and `l2SourceFor` kept that as "has no level-2 cache". The gallery cancels whenever its wall
  moves on, so one mode switch mid-load refused the route until a reload with "has no level-2
  cache", on minnie65, which has one. Only a 404 is that verdict now; anything else is thrown and
  not kept.
- **`skeletonServiceFor`** did the same with the versions list: a failed read became "no versions",
  so "no service", kept.
- **Both shared one in-flight request among callers and carried the first caller's signal**, so
  one caller's Cancel was everybody's. Both now ask with nobody's signal; each is one small JSON
  document.
- **`barren` was learnt from a set of one.** A whole set uncached marks a service empty for the
  session, to spare FlyWire and BANC (0 of 5 cached) a wasted `exists`. The gallery asks one cell
  per request, so its first uncached cell wrote minnie65's service off. `BARREN_EVIDENCE` is five,
  the measured case; the thumbnail's `learn: false` became that rule.

And the one underneath all of it: **the service's `exists` is rate-limited at 100 requests a
minute** (`429: 100 per 1 minute`, measured from the browser), and the gallery asked it once per
cell per wall, again on every reshuffle — two or three moves a minute were refused, and Automatic
read the refusal as "not cached". Three changes:

- **`existingSkeletons` remembers each id's answer for the session and gathers what is asked in
  one task into one request**, with nobody's signal. Measured size: the endpoint took 50,000 ids
  (0.9 MB, 23 s) in one request and refused 125,348 (2.3 MB) with `413` before reading it, so the
  ceiling is the proxy's body size, not an id count; `EXISTS_BATCH` stays at 500.
- **`DataSource.planSkeletons`**: a caller about to fetch neurons one at a time names them first,
  and CAVE asks `exists` once for the set. A wall, a mode switch and four reshuffles measured
  **one** `exists` request for 288 ids, where it had been one per cell per wall.
- **A failed `exists`, or a failed service lookup, fails an Automatic fetch** with a sentence
  saying so, rather than sending the neurons to the level-2 route unlabelled. Only a 404 is "none".

### A geometry is the id asked for — why there is no SWC release route

**A skeleton or mesh answered for an id is the morphology of exactly that id, at the
materialization asked for. Never an id mapped to another timepoint and that timepoint's
morphology drawn under it.** This was learned by shipping the opposite, briefly, and it is the
rule the user stated when it was found.

MICrONS publishes its v661 skeletons on BossDB — 76,980 SWC files named `{root id at 661}_{nucleus
id}.swc`, soma, axon and dendrite labelled, the axon removed wherever it was not proofread at 661.
It was added as a route that *led* Automatic on minnie65: today's root id was walked through its
nucleus at the requested materialization, the supervoxel under that nucleus looked up at 661's
instant, and the file for *that* root read and handed back under today's id. Every step was exact
and the result was wrong: it was a different segment, the cell as it was two years and a great deal
of proofreading earlier. Found from the gallery, where cells marked axon-proofread in
`aibs_cell_info` kept drawing without an axon — `864691136314078013` came back as 2.9 mm of dendrite
where the id's own segment is 22.9 mm with a proofread axon. Measured over 40 cells spread across
the 2,220 doubly-proofread ones: **23 had no axon in the release, 36 held under 80% of the current
cable, median 49%**. Nothing about the value said so; it looked like a smaller neuron.

So the route is gone rather than demoted. A published product keyed by other ids is usable only
where its ids *are* the requested ones — which for a proofread dataset is almost never, since
proofreading is what changes a root id. `live.test.ts` holds the cell above to having its axon.

What survived it, being correct on its own terms:

**A nucleus is one read, shared** (`cave/nuclei.ts`, declared as `DatastackSpec.nuclei`): its id,
the supervoxel under it and its position in nanometres, at the requested materialization,
memoised for the session. `somaPositions` places a cell by it. A root holding two nuclei (a merge)
or none has no soma. The position arrives as `pt_position_x`/`_y`/`_z` when `pt_position` is asked
for; naming the split columns is a 500.

**Root lookups at one instant are gathered** (inside `rootsForSupervoxels`, the root-id drift
repair): held in memory for the session over the persisted copy, which is read once, and every
supervoxel asked for within one task goes out in one `roots_binary` request, the store written
once per flush. Per call, concurrent callers each read and rewrote the whole stored map and
overwrote each other's additions.

**The service's `compartment` is `uint8`, and the reader only read `float32`.** Its `info` on
skeleton version 4 declares `radius` `float32` then `compartment` `uint8` — decoded live as one
soma, 3,026 axon and 2,017 dendrite vertices — and a trailing, undeclared block of one byte per
vertex follows, which the reader ignores. `readAttribute` reads `radius` only as `float32` (a
quantised radius is a unit this has no scale for) and `compartment` at any integer width, being a
code rather than a measurement. The service labels an axon on every cell by an automatic
synapse-based split, so only an `axon_cleaned` cell's axon is a proofread one.
