# Backends: precomputed

Neuroglancer precomputed sources: parsing a source, reading what is at a URL, skeletons and meshes.
[backends.md](backends.md) holds what all of them share — the geometry cache and streaming.

## Precomputed

`src/data/precomputed/` reads neuroglancer precomputed meshes. It knows nothing about
neuPrint — FlyWire and CAVE were the obvious next consumers and both now use it — and
`src/data/neuprint/nglayers.ts` maps a *neuPrint dataset* to a bucket. Since the
`Neuroglancer Source` node it is also reachable directly: a URL somebody pastes becomes a
`PrecomputedSource`, which is a `DataSource` that answers geometry and refuses everything else.
See [datasets.md](datasets.md) for why that is a *datasource* rather than a dataset.

### One parser for the three spellings of a source

`data/neuroglancer/sourceUrl.ts`. Neuroglancer accepts a legacy scheme prefix
(`precomputed://gs://…`), the current pipe syntax (`gs://…|neuroglancer-precomputed:`) and, in
practice, whatever somebody copied out of a layer's Source box. All three name one directory, and
a reader has no reason to know which they got — so they collapse onto one canonical string, which
is also the registry key. Two spellings landing on two keys would re-probe the same `info` and
hand two nodes different dataset ids for one bucket.

**The location keeps its own scheme.** `gs://bucket/path` is not turned into an HTTP URL until
something asks for `url`, because the object-store form is what a layer's `source` field wants
back. `middleauth+` is stripped as part of normalising: it is an instruction to a viewer rather
than part of an address, and the two viewer flavours disagree about whether it belongs (see
`#middleauth+ is spelunker's, not neuroglancer's` above).

**`precomputedToHttp` is narrower than the parser on two axes and stays that way.** It is
`meshSourceFromState`'s candidate filter, and the preference order it feeds is measured rather
than derived — the paragraphs below record what preferring the wrong candidate cost. So it
requires the format to have been *stated* (a bare `gs://` is not enough, where the parser reads
one as precomputed) and the location to be a bucket. It moved here out of `nglayers.ts` when the
node arrived; leaving a copy behind would have made the "two functions of one name two directories
apart" warning in `fetchText.ts` true a second time.

### What is at the end of a URL, read once

`probe.ts` reads the same `info` documents `openMeshSource` does and keeps the whole answer rather
than the one branch a fetch needs. A **card** needs the rest: whether this is a segmentation or an
image stack, whether there are meshes at all, and whether they are multi-resolution or the flat
kind. It is memoised per URL, **failures included**, because the node above it is `cheap` — see
[datasets.md](datasets.md) for that trade and for the optimistic-capability rule that goes with it.

It also **opens** the mesh and skeleton directories, through `openMeshDir`/`openSkeletonSource`
rather than by re-reading `@type` itself — so the card's verdict and the fetch's cannot disagree
about one URL. Both are opened together rather than in sequence; they are independent reads and
this runs from an edit-time peek, where a wasted round trip is visible. The opened sources are
kept on the description, which is what makes the first Run cost **no requests of its own**.

**What comes back from that open is an optimisation, not a verdict**, and the distinction is
load-bearing. A transient failure is indistinguishable from an unreadable directory, and the probe
is then cached as a *success* — so `meshDir` keys its refusal on whether the source **names** a
mesh directory and re-opens when the cached copy is absent. Keying it on the opened copy meant one
CORS blip produced "publishes no meshes" for the rest of the session, on a source whose
`capabilitiesFor` still said it had them.

**`@type` is optional on a volume, and both readers ask `isVolumeInfo` rather than switching on
it.** This was a `switch (info['@type'])` with `undefined` falling to "legacy mesh directory",
which is right for a mesh directory and wrong for every flat segmentation published before the
field was conventional. `gs://flywire_v141_m783/info` declares `"type": "segmentation"`, eight
`scales`, `"mesh": "mesh_mip_1_err_40"`, `"skeletons": "skeletons_mip_1"` — and no `@type` at all.
Read as a mesh directory it opened as `legacy` **at the bucket root**, where no manifest exists; so
every request 404d, and because a missing mesh is an ordinary answer the whole thing surfaced as
"these neurons have no meshes" rather than as a bad URL. Two multi-resolution mesh sets and a
skeleton set were unreachable behind it. The volume markers decide it instead — `scales`, or a
named `mesh`/`skeletons` — and a mesh or skeleton directory's own `info` carries none of the
three, which is what makes the test a discrimination rather than a heuristic.

**`openMeshSource` resolves; `openMeshDir` opens, and only the second forgives a missing `info`.**
A legacy mesh directory commonly publishes none — banc's `neuron_meshes` names `meshes`, and
`meshes/info` 404s — so for a directory a volume already *named*, absent means legacy. Only a 404:
a CORS refusal or an unreachable host read the same way would turn one blip into a directory whose
every manifest request 404s, reported per neuron as a missing mesh. `openMeshSource`, which has to
decide what a URL *is*, stays strict, because a URL with nothing at it is a URL nobody can use.

**An abort is not remembered.** Cancelling a run says nothing about the bytes, and a memoised
"This operation was aborted" sat on a card with a perfectly good URL. It rejects rather than
resolving a verdict, which is also the scheduler's own rule for an aborted run.

**`fetchInfo` memoises `/info` by URL**, successes only. An `info` is the published description of
a released dataset and is immutable under a fixed URL, which is what makes the cache correct
rather than merely convenient — and without it one document was fetched three times for a pasted
segmentation: once by the probe, once by `openMeshSource`, and once more by `readMultiResInfo`
inside it. That last pair is pre-existing and every backend's mesh open paid it. Failures are not
held (they are usually transient, the same reason `remember` refuses to persist `unreachable`),
and in-flight requests are not deduplicated, because sharing one promise would let one caller's
`AbortSignal` reject for every other.

**A host that has answered direct reads is retried, not routed, when a read comes back with
nothing** (`retryDirect` in `fetchBytes`). A browser reports a dropped connection exactly as it
reports a CORS refusal — an opaque `TypeError` — so the fallback chain read a reset as a refusal and
the error said the host "refuses cross-origin reads". Found on BigClust's public example: its
60 MB `features_0.parquet` is read in about 8,400 ranged requests, and one in a few thousand came
back `206` and was then reset mid-body (`net::ERR_CONNECTION_RESET`, seen through the DevTools
protocol) — one reset failing the whole project. Twice more, after 250 ms and 1 s, and an answer of
any kind settles it as before; a host that has never answered still takes the routes. A run that
keeps dropping says the connection dropped, naming no CORS.

Checked against the live buckets (`live.test.ts`, `PRECOMPUTED_LIVE=1`):

    male-CNS v1.0     segmentation, mesh: multi-res-meshes (draco), skeletons: skeletons-malecns/…
    hemibrain v1.2    segmentation, mesh: mesh (draco), segment_properties: segment_properties
    male-CNS supervoxels   segmentation, no mesh directory at all
    male-CNS synapses      neuroglancer_annotations_v1

Two of those are the cases the classification exists for. **male-CNS's volume declares
`mesh: multi-res-meshes`** while the viewer state it publishes advertises
`meshes-malecns/single-res-meshes` — following the volume is the correct branch, and it is the
same finding the preference order below records from the other direction. And **a segmentation
with no mesh directory is a real, common thing**, so "is a segmentation" and "has geometry" have
to be separate questions or a Meshes node runs and fetches nothing.

### Voxels

`volume.ts` and `compressedSegmentation.ts`. Until these, Coda could find the *meshes* inside a
volume and nothing else — `isVolumeInfo` existed only to route past a segmentation to the mesh
directory it names. A caller now hands it a box of nanometres and gets the voxels covering it.
Built for SEAM's candidate search, which needs a 6 µm cube of supervoxels around each open end,
but it is a precomputed capability and knows nothing about SEAM or graphene: a `graphene://`
source is resolved to its bucket by `cave/meshes.ts`' `openGrapheneMeshes` pattern, one layer up.

**Labels and images are two functions, not one with a flag.** `readLabelBox` answers "which
objects are here" and returns the box **factored** — distinct labels plus an index per voxel —
because that is the shape `compressed_segmentation` already stores and the shape every consumer
wants; a 4.7 M-voxel cutout is 38 MB expanded and 19 MB factored beside a few thousand labels.
`readScalarBox` answers "what are the values here" and returns them plainly, because in an image
every voxel is its own number and a lookup table would be larger than the data. Each refuses the
other's encodings by name rather than decoding them into noise.

**The index is as narrow as the box's own table** (`VoxelIndex`: `Uint16Array` or
`Uint32Array`). A cutout names a few thousand objects with millions of voxels — a 6.0 M-voxel
neuron box measured 20,243 supervoxels — so the wide form is mostly zeroes, and the box above is
9.5 MB rather than 19. `readLabelBox` allocates narrow and widens on the first chunk that pushes
the table past `NARROW_INDEX_LABELS` (65,536), carrying across what is already pasted; above
that the wide form is the only correct one. The guard rail still prices four bytes a voxel,
because nothing knows at the start how many objects a box holds, and refusing on the narrow
figure would let a caller start a box it cannot finish.

It matters most where the box is handed to Python. `callPython` copies it into a wasm heap that
is **never given back to the operating system**, so what crosses is paid for the life of the
worker: cutting the assessor's patches for one 66-candidate tip went from a 220 MB peak to
201 MB, measured by `pnpm probe:assessor-patch -- --end 1014`. The Python reads whichever width
arrives and refuses a table too big for it by name — an index past its width has already wrapped
onto a different supervoxel, which is a full answer about the wrong objects.

#### Three things that are silent when wrong

All three produce a perfectly ordinary-looking box, which is why each has a test whose fixture is
chosen to break it rather than to pass.

- **The grid is anchored on `voxel_offset`, not on zero.** Aedes' 32 nm scale starts at
  `[1024, 1536, 0]`. Flooring absolute coordinates by the chunk size asks for chunks that are
  offset by part of a chunk in x and y — every one of which exists and returns data, just not the
  data under the point. Nothing 404s. The tests use Aedes' real offsets because a scale starting
  at the origin, which is most test data, exercises none of it.
- **A chunk's name states the clamped extent.** The last chunk of an axis is named for where the
  volume ends (`…_7424-7482`), so always writing `start + chunkSize` 404s at exactly the three far
  faces of the volume — where, in a brain, nothing interesting is.
- **Voxels are x-fastest.** cloudvolume passes `order='F'` explicitly and the first decode written
  here did not, which is how this was found: a transposed block of segmentation has the same
  labels, the same voxel counts and the same histogram as the right one. The goldens are flattened
  `order='F'` by the reference encoder, and the `ragged` and `asymmetric-block` cases exist because
  a cubic block size hides an axis swap completely.

#### Decoding only the box

The format cuts a chunk into small blocks (`8×8×8` by convention, stated in the `info`), each with
its own lookup table and its own bits-per-voxel — a block of one label costs zero bits. So the
decoder takes the sub-box and visits only the blocks meeting it. That is not a micro-optimisation:
a 188³ cutout sits inside chunks of 256×256×64, so a whole-chunk decode is about eight times the
work and eight times the memory for the same answer. The *fetching* cannot be helped — a chunk is
the unit the store serves.

#### The table is a function of the data

Chunks are fetched concurrently, so the order labels are first seen in is the order the responses
landed. `readLabelBox` therefore sorts its table and remaps at the end, and drops any slot nothing
used — label 0 holds slot 0 from the start so that an absent chunk needs no special case, and is
removed again if no voxel turned out to be 0. Without the sort, two reads of one box return the
same voxels under different indices and anything caching, hashing or comparing a cutout sees them
differ for no reason; without the compaction, the table names an object the box does not hold.

**An absent chunk reads as zero, and only a 404 counts as absent.** Segmentation volumes are
sparse at their edges and an unwritten chunk is an ordinary answer. A CORS refusal or a 500 is not
an answer about the data, and still throws — the same distinction the mesh readers make.

#### Measured, against the live Aedes store (2026-11-10, `pnpm probe:volume`)

| | |
| --- | --- |
| store | `storage.googleapis.com/fanc-fly_segmentation/wclee_aedes_brain` |
| auth | **none — public, `access-control-allow-origin: *`** |
| scale | `32_32_45`, `compressed_segmentation`, block `8×8×8`, unsharded, `uint64` |
| one 6 µm cutout | `188×188×134` = 4.74 M voxels, **8 chunks**, 24.6 MB |
| in the browser | **1,295 ms** (the `info` a further 209 ms) |
| against the reference | 14,424 distinct labels and 4,608,675 non-zero voxels, **exactly** |

The probe compares against `__fixtures__/aedesCutout.json`, decoded by the Python
`compressed_segmentation` package at `order='F'`. It carries both counts **and forty named
voxels**, and the named voxels are the point: a transposed or offset read matches both counts
exactly, because a wrong-but-consistent read holds the same labels in the same proportions. Only
asking what is at `177, 117, 91` tells them apart.

#### What the reader refuses, and what it leaves to the caller

**One allocation refusal:** a box no runtime can allocate (`refuseUnallocatable`, against
`CRASH_FLOOR_BYTES`), because the box is sized by the caller and a mistaken centre or half-width
otherwise arrives as `RangeError: Invalid array length`.

**The rest are refusals of a question that cannot be answered**, and every one of them replaced
an answer that looked fine:

- **A box outside the scale**, or empty along an axis. Past the grid, `chunksCovering` mints a
  name whose start is beyond its clamped end (`22784-22016`); that 404s, a 404 means "nothing is
  written here", and the box came back with a band of zeros along the face — indistinguishable
  from the real edge of a segmentation. On a *sharded* scale it is worse: the morton code of an
  out-of-grid position can alias onto a key that exists, filling the box from somewhere else.
  `boxAround` clamps, so the ordinary path never trips this.
- **A label scale that is not `uint32` or `uint64`.** Anything else was decoded as `uint64`; on
  `compressed_segmentation` there is no length to disagree with, so it returned plausible
  18-digit labels assembled from pairs of 32-bit words.
- **A multi-channel volume.** Both readers answer about channel 0 and neither can be asked for
  another, so `num_channels` is read for this and nothing else.
- **A sub-box reaching past its chunk** (in the decoder). The block loops clamped but the size
  came from what was *asked for*, leaving the overhang as index 0.
- **A block claiming a width that is not 0, 1, 2, 4, 8 or 16.** The packing puts whole values
  into 32-bit words, so any other width decodes plausible garbage rather than being named corrupt.

**A scale in an encoding this reader does not decode is left out, not refused** — a volume
publishing a `jxl` mip beside readable ones is ordinary, and `scaleNear` would never pick it.
Only a volume with nothing readable left refuses, naming what it found.

**The wait is the caller's to price, and this is where to say so** before somebody adds a
`MAX_VOXELS` here. One cutout is ~1.2 s and 24.6 MB; a reader doing one per open end is doing
that N times, which is exactly the case `MESH_WARN_SECONDS` is on record for — the one you
measure alone is a big one. `src/packs/seam/checkAffinitySize.ts` is the shape: the per-item
allocation refuses from the floor, the *set*'s wait warns through a `Warner` the reader has and
`src/data` does not. `chunksCovering(...).length` is public so a caller can price it before
starting.

#### Sharded volumes, and images — measured on the MaleCNS EM (2026-11-10)

Both were built before anything exercised them, and one volume covers both:
`gs://cns-full-clahe`, the MaleCNS image data, is `jpeg` **and** sharded, public and CORS-open.
`pnpm probe:volume`'s second arm reads one chunk of it.

A sharded scale keys its chunks on the **compressed Morton code** of the grid position — not on a
segment id, so `readShardedObject` cannot be handed a chunk directly, though the read that
follows the key *is* its. The code interleaves the three coordinates' bits low-to-high,
*skipping an axis once its own grid is exhausted*, and that skip is the whole difficulty: a plain
Morton code agrees with it exactly while all three axes are the same size, which is what every
hand-written test uses. Pinned against cloudvolume's own `compressed_morton_code` over seven
grids, four of them not cubes — and now against a real sharded store.

`jpeg` and `png` go through `createImageBitmap` and a canvas rather than a bundled decoder: no
bundle cost, and whatever the browser reads. The specification permits colour management on the
way in, which would make the readback inexact; `colorSpaceConversion: 'none'` and
`premultiplyAlpha: 'none'` prevent it, and **the probe measures that they do** — one EM chunk
read this way is byte-identical to Pillow's decode of the same bytes, all thirty sampled voxels,
with the mean and standard deviation agreeing to four decimals. The spec still only *permits*
exactness, so a reader that cannot tolerate a browser disagreeing should use a `raw` scale.

Note also that neuroglancer stores a 3-D chunk as a **tall 2-D image**, z sections stacked down
the height (a 64³ chunk decodes to 64×4096). Reading it as one `chunkX × chunkY` image gets
section 0 right and repeats it down the stack — whose mean and standard deviation are perfectly
ordinary, which is why the probe compares two z sections directly.

**Finding a chunk that exists is its own small lesson.** The first grid point tried — the middle
of the volume — is not stored at all: a sharded store simply has no key for an empty region, and
`readScalarBox` reads that as `missingChunks`, not as a failure. The golden's chunk was chosen
for the highest variance among the largest blobs nearby, so that a transposed or mis-stacked read
cannot match it.

### Skeletons

`skeletons.ts`, and the format is four lines: `uint32 numVertices`, `uint32 numEdges`,
`float32 positions[n][3]`, `uint32 edges[m][2]`, then one contiguous array per entry of
`info.vertex_attributes`. What makes it a module is the three things that are not in the bytes.

**The edges are a graph and `SkeletonGeometry` is a tree.** Nothing in the format says otherwise:
the edge list is undirected, unordered, and may hold cycles or disconnected components. The
conversion is `spanningForest` in `data/skeletonTree.ts` — breadth-first, one root per component,
points emitted in visit order so a parent always precedes its child. It moved there out of
`cave/l2.ts` when this became its second caller, and the reason to move rather than copy is that a
cycle surviving into `parents` makes every consumer that walks to a root loop forever. What stayed
in CAVE is the part that is about CAVE: dropping chunks with no cache entry *before* the walk, so
it routes around them instead of orphaning their children.

**`radius` is a convention in `vertex_attributes`, not a field**, and usually there is not one.
male-CNS publishes `{"@type": "neuroglancer_skeletons"}` and nothing else — no transform, no
attributes — so every radius is 0, the same answer `cave/l2.ts` gives a chunk with no distance
transform. Attributes are contiguous per-attribute arrays in declared order, so reaching a
`radius` behind another attribute means stepping over it by size; a lookup by name would read the
wrong bytes. Only a single-component `float32` is read, because a `uint8` radius is in a quantised
unit this has no scale for — a plausible number in the wrong units is worse than an honest zero.

**Coordinates are already nanometres.** Measured: male-CNS vertices come out around 3.6e5, in a
volume ~93,800 voxels of 8 nm across. A reader that scaled them by the voxel size would put every
skeleton 8× away from the mesh of the same neuron, with nothing failing, because both sets are
internally consistent — which is why `live.test.ts` fetches one body both ways and asserts the
boxes overlap. An `info` *may* carry a `transform`, and this applies the **full** 3×4 affine where
`fragmentTransform` uses only its diagonal. Not an inconsistency: the mesh transform runs per
vertex over millions of quantised vertices and every mesh source in reach is a pure scale, where a
skeleton is hundreds of points and the full matrix costs nothing.

**No manifest sweep, so it streams from the first arrival** — one request per body, at the same
bucket concurrency the mesh path uses, and `onProgress` gets the whole bar rather than the mesh
path's four-fifths.

**Meshes need no token and usually no proxy.** They come from public object stores, not from
neuPrintHTTP. `neuroglancer-janelia-flyem-hemibrain`, `manc-seg-v1p2` and `flyem-optic-lobe`
all send `Access-Control-Allow-Origin: *`, so they are fetched directly and work in a static
deploy with no proxy — which, since neuPrint gained CORS, is true of the Cypher API as well. `flyem-male-cns` sends no CORS headers at all. A
browser reports a CORS refusal as an opaque `TypeError`, so trying is the only way to find out —
which is why the answer is cached rather than probed each time.

**male-CNS is read through the GCS JSON API, and that is why the deployed site can show it.**
Google serves the same object under two endpoints, and only one of them consults the bucket's
CORS policy:

    XML / direct   storage.googleapis.com/<bucket>/<key>
    JSON API       storage.googleapis.com/storage/v1/b/<bucket>/o/<urlencoded key>?alt=media

The JSON API answers `Access-Control-Allow-Origin: <the requesting origin>` whatever the bucket
says. That is the whole of how neuroglancer reads male-CNS — its `gs://` driver builds exactly
this URL in `src/kvstore/gcs/index.ts` — and it was the missing piece here. The absence is not an
allow-list Coda is off: re-probed from six origins including `neuroglancer-demo.appspot.com`,
`clio-ng.janelia.org` and `neuprint.janelia.org`, the bucket returns no header to any of them.

Measured against the real bucket from `Origin: https://coda.science`: `info` 200 with the header;
a 32-byte `Range` out of the 1.24 GB `000.shard` returns **206** with `Content-Range` both present
and listed in `access-control-expose-headers`; and the `OPTIONS` preflight allows `range` with
`max-age: 3600`. So it carries the sharded reader's actual workload, not just the metadata.

**The order is `direct` → `gcs-api` → `proxy`**, each tried only when the one before it *threw*.
`gcs-api` goes ahead of the proxy for two reasons pointing the same way. It works in a static
deploy, where `/gcs` is a path on this origin that nothing serves — `coda.science` answers it with
GitHub Pages' 404 page, which is a `PrecomputedFetchError` rather than a route failure, so before
this the bucket was simply unreadable in production and said so as *"male-cns:v1.0 does not
publish a mesh source"* three layers up. And it is a real cross-origin host, so it multiplexes
instead of queueing behind the single-origin hop the 30.5 s below measures. The proxy stays third
because it is not GCS-specific and is all that is left for some other host that refuses.

**A route that answered settles it, whichever route that was.** Only a thrown fetch moves to the
next one: `skeletons.ts` and `readRawInfo` both read `status === 404` as "this object is absent",
and a refusing bucket must not turn that into a different verdict from a CORS-open one.

**The cache-busting parameter neuroglancer appends is deliberately not copied.** Its comment cites
[crbug 1214563](https://bugs.chromium.org/p/chromium/issues/detail?id=1214563) — GCS omitting an
updated `Access-Control-Allow-Origin` on the 304 that answers a cache revalidation, which would
make a warm cache fail CORS about an hour in, intermittently. Re-measured rather than assumed, and
it no longer reproduces: a conditional GET with `If-None-Match` returns 304 carrying
`Vary: …,Origin,X-Origin` and the *requesting* origin's header, including after the edge was
primed from a different origin. The objects are `public, max-age=3600, must-revalidate`, so a
unique URL per request would throw away every revalidation for a bug that is fixed. If it returns,
the symptom is a CORS failure that appears only on a second visit, and the fix is one parameter.

**That answer is cached per _bucket_, and it used to be per host.** All four of those buckets are
`storage.googleapis.com`, but CORS is configured per bucket — so a host key meant one male-CNS
mesh recorded `storage.googleapis.com → proxy`, **persisted it to localStorage**, and from then
on routed every hemibrain, MANC and optic-lobe read through the proxy without ever retrying
direct. In later sessions too, for somebody who never opened male-CNS again.

Measured on a 300-body hemibrain fetch: **3.1 s direct, 30.5 s through the dev proxy**. The
requests are all issued either way — the browser reports 100 in flight — they just queue behind a
single-origin HTTP/1.1 hop. It was invisible while the concurrency was 6, because then both
routes were slow; raising it to 100 is what made the difference legible. Entries written by the
host-keyed version are dropped on load rather than migrated: a bare host stood for whichever
bucket happened to be read first, so it cannot be mapped onto one, and keeping it would leave
every affected profile poisoned across the upgrade.

**Find the source through `/api/npexplorer/nglayers/<dataset>.json`, not `Meta`.** The Meta
node is unreliable (hemibrain has `neuroglancerMeta`, manc:v1.2.3 has nothing); the nglayers
endpoint always names the segmentation. Ignore the `*_property` sidecars, of which male-CNS
has eight.

**Preference order is multi-res layer → segmentation volume → any other mesh-shaped layer,**
and the two ends pull against each other:

- optic-lobe's volume declares `mesh: single-res-meshes` (flat, full resolution) while a
  `multi-res-meshes` **sibling** exists and is what its state links. So a dedicated multi-res
  layer must beat the volume.
- male-CNS's state advertises `meshes-malecns/single-res-meshes` while its volume declares
  `mesh: multi-res-meshes`. So a _legacy_ dedicated layer must **not** beat the volume.

Preferring any hinted layer over the volume — which this originally did — got male-CNS wrong
with nothing failing: meshes still arrived, just at full resolution and several megabytes each.

**Two formats, detected from the mesh dir's `info`.** All four datasets in use publish sharded
`neuroglancer_multilod_draco` with four levels; the legacy `neuroglancer_legacy_mesh` path
exists because optic-lobe and male-CNS also publish single-resolution directories, and a
misresolution lands on one.

Four things about the sharded format that are easy to get wrong, all of them found the hard
way and all pinned by tests:

1. **Shard math.** `shifted = key >> preshift_bits`, then murmurhash3_x86_128 of its 8
   little-endian bytes, taking `(h2 << 32) | h1`; minishard is the low `minishard_bits`, shard
   the next `shard_bits`. Body 1158187240 must land in shard `0x151`, minishard 103.
2. **Fragment positions are three arrays, not interleaved triples** — every x, then every y,
   then every z. The wrong reading still yields valid coordinates and is _invisible at the
   coarsest level_, where hemibrain's `0,0,0,0,0,1,0,1,1` decodes identically either way. It
   showed up one level down as fragments scattered across the volume.
3. **`vertexOffsets` are not zero** (hemibrain: 1 at LOD 1, 4 at LOD 3). Dropping them shifts
   geometry by 16–64 nm, which reads as rounding.
4. **Fragment data sits immediately _before_ the manifest** in the shard. There is no pointer
   to it; `dataStart = manifestOffset - Σ every fragment size`.

**Everything is nanometres.** neuPrint returns skeletons and synapses in dataset voxels
(8 nm), precomputed meshes come out in nm — drawn together unconverted, the mesh sits 8× away
from the skeleton it should wrap. `data/units.ts` scales the neuPrint side using
`Meta.voxelSize`, so `cableLength` is in nm and skeleton coordinates no longer match the raw
API response. That is the trade, and it is checked: a mesh bbox must enclose its skeleton's.

**`Warn above` is about requests; `Detail` bounds weight; `maxBytesPerBody` bounds one neuron.**
Three different guard rails. Conflating the first two is how the mesh limit ended up at 25 — a
number from before levels of detail existed, which refused thirty neurons that would have
arrived as a few hundred kilobytes. All three morphology nodes now share `MAX_NEURONS`, at
10,000, and it is a warning threshold rather than a ceiling — the control was renamed from "Max
neurons" when it stopped refusing, since that is the one way it could lie about what it does.

The third exists for thumbnails, and it is needed because **even the coarsest level has a
2000× spread**. Sampled across hemibrain, the coarsest level is 264 bytes at the median, 14 kB
at p90 and 508 kB at the maximum (male-CNS: 7.3 kB / 23 kB / 169 kB). A budget averaged over a
batch cannot express "skip this one body"; the manifest carries the size, so the decision costs
no download.

**`THUMBNAIL_MAX_BYTES` is a guard rail, not a quality filter,** and the distinction is the
whole point of the number. It is 2 MB, above the largest coarsest level in any dataset here, so
every real neuron gets a thumbnail; 2 MB is what an entire hemibrain neuron costs at full
resolution (2 MB / 280 kB / 48 kB / 11 kB), so a body whose _coarsest_ level reaches it is an
unsplit blob rather than a large neuron. It was 128 kB, pitched just above p90 to keep a page
cheap — which blanked the giant fibres and big tracts, i.e. both the heaviest coarse meshes and
the bodies someone browsing is most likely to want. A page is priced by the median, not by the
ceiling, so raising it costs the typical page nothing.

**There are two ceilings, because a level and a whole body are not the same measurement.** Every
word of the argument above is about a _level_ — it compares the coarsest of four against what all
four cost. A flat store has no levels: DVID's `.ngmesh` is the only mesh there is, so the same
number is being asked to tell a big neuron at full resolution from a blob at full resolution, and
2 MB is hemibrain's answer to a question about somebody else's dataset. On `neuprint-fish2`, a
whole-brain larval zebrafish segmentation whose meshes come from a DVID keyvalue store, it blanked
**one Explore row in twelve**, and the rows it blanked were the big neurons — the reported symptom
was "some neurons never get a thumbnail". `THUMBNAIL_MAX_FLAT_BYTES` is **12 MB** and
`thumbnailCeiling(source)` is the one place that chooses, since a second caller choosing for
itself is a silently blank tile.

12 was measured on fish2 rather than picked. Over the top 200 bodies by voxel count (40 read, the
99.91st percentile upwards) the meshes run to a **maximum of 8.31 MB**, median 3.01 — and the
single largest body in the dataset, at 1.1 billion voxels, is only 3.37 MB. A random 120 across
the whole 224,385-row index: median **0.54 MB**, p90 1.92, none over 3.56. So the real arbors stop
around 8 MB and the ceiling clears them with room. What it still refuses is what it is for: one
stratified sample turned up a **27.4 MB body at 846M voxels whose same-size neighbours are 6–8
MB** — four times the bytes for the same volume, which is what an unsplit merge looks like — and
the 107 MB body below. Both stay placeholders.

It costs almost nothing, which is the other half of the measurement. fish2's *mean* body is
~0.8 MB, so a 25-row page came to **~19.4 MB truncated at 2 MB and ~20.5 MB at 12** — the old
ceiling was blanking 8% of rows to save 5% of the bytes. Nothing else moves: mushroombody, the
other DVID repo, tops out at 487 kB and never approaches either number. (The page cost is itself
worth knowing — `fetchCoarseGeometry` is documented as ~10 kB a row and fish2 runs ~800 kB a row
whether or not anything is refused. That is a fact about the dataset, and no ceiling fixes it.)

**100 bodies in flight, which is neuroglancer's own number** (`data_management_context.ts`:
`download: { defaultItemLimit: 100 }`). It was 6, which had never been measured and cost about an
order of magnitude. Measured in a real browser against the hemibrain bucket with the HTTP cache
disabled, ids enumerated out of the bucket's own minishard indices so they spread across shard
files, best of two interleaved runs each:

| in flight | 96 bodies | of which manifests | 32 heavy bodies |
| --- | --- | --- | --- |
| 6 | 10,463 ms | 7,973 ms | 3,094 ms |
| 16 | 3,908 ms | 3,069 ms | — |
| 32 | 1,944 ms | 1,589 ms | 697 ms |
| 64 | 1,369 ms | 1,134 ms | 685 ms |
| 100 | 819 ms | 718 ms | 692 ms |

**The gain continues while the limit is under the batch size** — 32 bodies plateaus at 32, where
there is nothing left to overlap, while 96 is still improving at 100. So this is a latency budget,
not a bandwidth one, and the number to compare it against is how many neurons a scene holds.

**The manifest sweep is where the time goes**: ~87% of the wall clock at every setting. One small
request per body, and nothing can start until the last one lands, because `chooseLod` sums across
the batch. That is the barrier, and it is why manifests get a cache entry of their own — being
level-independent, they survive a change of detail that invalidates every fragment.

One measurement, one machine, one network; the shape is what matters rather than the milliseconds.
What it spends is the HTTP/2 stream budget on `storage.googleapis.com`, which many peers default to
~100 and which CAVE's fragment reads and Explore's thumbnails also draw on — overflow queues in
the browser rather than failing, and graph nodes execute one at a time.

**The other concurrency numbers are deliberately not this one.** `ROI_MESH_CONCURRENCY` is 4 and
neuPrint skeletons are 6 because those hit **neuPrintHTTP**, a shared production server, not a
bucket; CATMAID is 8 against somebody's tracing instance; CAVE's fragment budget is a measured 32
shared across neurons in flight. Only the object-store path gets the bucket number.

**Detail is chosen, not fixed.** `chooseLod` picks the finest level fitting a triangle budget
across the whole batch, using the manifest's compressed byte sizes as the pre-decode proxy at
~1.7 bytes/triangle. That ratio is dataset-dependent (optic-lobe overshot 2×), so the result
reports the triangles actually decoded and the viewer caption shows `mesh LOD n/m`.

**The Draco decoder must stay out of the main chunk.** `draco3d/draco_decoder_nodejs.js` is
misleadingly named — it is a universal Emscripten build whose `require("fs")` is behind a
Node-only guard — and the wasm is handed over explicitly via a `?url` import so Emscripten
never guesses at a path the bundler has hashed. Do not import three's `DRACOLoader` here:
it would pull three.js into `src/data`, which has to stay usable by a non-browser consumer.
