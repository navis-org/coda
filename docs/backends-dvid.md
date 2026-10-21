# Backends: DVID

DVID: discovery, meshes and skeletons, the size ceiling, auth. [backends.md](backends.md) holds what
all of them share — the geometry cache and streaming.

## DVID

Janelia's versioned image/annotation server. Coda reads two things from it — meshes and
skeletons — and reads them because certain datasets have no other source: `mushroombody` and
`fib19:v1.0` name a `dvid://` segmentation in their published neuPrint state and no object store
at all, which is why both used to answer *"does not publish a mesh source"*.

**The published state is already the primary source, and always was.** `fetchNgState` reads
`/api/npexplorer/nglayers/<dataset>.json` and `meshSourceFor` resolves the mesh source out of it;
`Meta` is deliberately not consulted, for the reason recorded further down. So a dataset whose
`Meta` names no mesh source is not a dataset Coda cannot see one for — nothing needs to be added
as a fallback. Where such a dataset fails, the cause is in what the state *names* and whether
this reader accepts that shape, which is what the two rules below exist for.

**Two facts about deployments other than the public one**, both met on the same instance: its
`/api/npexplorer/nglayers/…` answers **401** where Janelia's public deployment answers
unauthenticated, and its segmentation is anisotropic at 16×16×15 nm. Neither needs code — Coda
sends the token on every neuPrint path anyway — but both falsify a sentence written when the
public deployment was the only one in view.

**A `dvid://` source names the segmentation, not the geometry.**

    dvid://https://flyem.dvid.io/babdf6dbc23e44a69953a66e2260ff0a/groundtruth
             └──────── server ────────┘└─────────── node ───────────┘└ instance ┘

Geometry lives in sibling keyvalue instances named by convention, `<instance>_meshes` and
`<instance>_skeletons`. **That convention is neuroglancer's and is followed exactly**
(`datasource/dvid/frontend.ts` builds the same two names and shows nothing when they are absent).
`AL-VA1v` on the public server is why it is not a search: its skeletons sit in
`bodies121714_skeletons`, left over from an earlier name for a segmentation now called
`segmentation`, so a search would find them and neuroglancer does not — and Coda showing
skeletons neuroglancer says are absent is a worse answer than showing none.

**The node is not validated as a full uuid**, because two published shapes are not one. DVID
accepts an **abbreviated** node — `fib19:v1.0` names `/93f08/segmentation`, five hex characters —
and a node may be **branch-qualified**, `<uuid>:master`, naming that branch's head rather than a
fixed version, which is what a dataset still being proofread publishes. The rule is hex, plus an
optional `:branch`. A wrong node costs nothing here; it fails at the first request with the
server's own words.

**A query string on the source is dropped, not refused.** A published source may carry a
`dvid-service=` parameter naming a shim that neuroglancer can route through. It is not part of
the address: measured on a live dataset, both `info` and a 92 kB body come back **byte-identical**
with the query and without it, because the host in the URL is a real DVID that answers on its own.
Refusing the source over it — the first rule here — threw away a whole dataset whose meshes are
perfectly readable. Appending it to every request is worse than useless: `fetchInfo` builds
`${base}/info`, so a carried query puts the path segment after it and every probe 404s.

### Discovery is one narrow question, deliberately

Existence is `<instance>/info`, never `/api/repos/info` — the latter answers with **every repo on
the host**, 42 kB naming other people's aliases, uuids and instances on the public server alone.
Most DVID deployments are reachable by anybody holding the address, so the address *is* the
access control: nothing here logs a URL, error messages name the server and stop
(`serverOf`), and Coda has no event analytics for one to reach anyway.

**400 means the instance does not exist and 404 means the body is not in it** — the opposite way
round from what a reader expecting REST would guess, and both are ordinary. Measured:

    GET …/groundtruth_meshes/info          200   the store is there
    GET …/groundtruth_skeletons/info       400   no such instance
    GET …/groundtruth_meshes/key/1.ngmesh  200
    GET …/…/key/5813020600.ngmesh          404   Key "5813020600.ngmesh" not found

### Meshes are nanometres and skeletons are voxels

**In the same repo, for the same body.** `AL-VA1v` body 1010, against that segmentation's own
extents:

| | range (x) | segmentation extent | unit |
|---|---|---|---|
| mesh | 18,043 – 91,635 | 21,504 – 120,824 nm | **nanometres** |
| skeleton | 2,270 – 11,454 | 2,688 – 15,103 voxels | **voxels** |

So `meshes.ts` scales nothing and `skeletons.ts` scales everything, and neither may assume the
other's rule. Left unscaled a skeleton draws at 1/8 inside the mesh it should thread with a cable
length 8× short, and **nothing fails**. The scale comes from the *segmentation* instance's
`Extended.VoxelSize` — a keyvalue store describes no geometry — so a skeleton read costs one
extra `info`. **A scale that cannot be read is a refusal, not an identity**: publishing voxels as
nanometres would make NBLAST score against a neuron eight times too small, well inside the range
its matrix finds plausible. See [units.md-in-code](../src/data/units.ts), which moved out of
`neuprint/` when DVID became its second backend.

Radii are scaled with the positions, through `scaleRadii` — `data/units.ts`' decision, by the
mean, exact because every dataset in reach is isotropic, and the same call neuPrint's SWC path
makes. Leaving them in voxels here would give one file format two treatments across two backends
and would quietly falsify the header `exportValue.ts` writes onto every saved SWC.

### `.ngmesh` is a format Coda already read

It **is** `neuroglancer_legacy_mesh`'s fragment — `uint32` vertex count, xyz `float32` triples,
`uint32` indices to the end — which is why `parseLegacyFragment` is exported separately from
`legacy.ts` and why nothing new decodes anything. What DVID drops is the manifest: a precomputed
legacy body is a JSON `<id>:0` naming fragments, a DVID body is one key.

Two SWC key spellings exist. `<id>_swc` is neuroglancer's and is asked for first; `AL-VA1v`
publishes both `1010_swc` and `1010.swc` for all 192 of its bodies, byte-identical, so the
fallback costs a second request only for a body that has neither.

### The size problem, and why the ceiling had to move

**A DVID body can be 107 MB** — `AL-VA1v` 1010 is 2,997,171 vertices — and there is no coarser
level to ask for. Worse, its size is unknowable in advance. All three ways of asking were tried:

- `HEAD` on a key → 200 with **no `Content-Length`**
- `Range: bytes=0-0` → **200, not 206** — ranges ignored
- no manifest, so no published byte count

So `fetchMeshes`' `maxBytesPerBody`, which elsewhere refuses from a manifest for free, had
nothing to read. `FetchOptions.maxBytes` in `precomputed/transport.ts` is the answer: it checks
`Content-Length` where a store sends one, otherwise streams and **cancels the reader** past the
ceiling, reporting **413**. The bound is on the *download*, not the decode; a check after
`arrayBuffer()` has already spent the bytes.

**413 and 404 used to be one answer, and separating them is what lets a blank tile explain
itself.** `readKey` folded both into `undefined`, which is right for a scene — a body that is not
in the result is not in the result, whatever the reason — and leaves an Explore tile drawing the
same glyph for "this neuron was never meshed" and "this neuron's picture is over your ceiling".
On a flat store the second is the *common* case rather than the rare one, so the reader answers
`OVERSIZE` for a 413, `fetchMeshes` reports `oversize` as a labelled subset of `missing`, and
`DataSource.fetchCoarseGeometry` hands back a `CoarseRefusal`. `oversize` is a plain list in
whatever order the refusals arrived, deliberately: its only reader is `fetchCoarseMesh`, which asks
about **one** body, so it exists to tell a refusal from an absence rather than to be read against a
page. An ordered version was built, and the test that justified it was written after a mutation
showed the ordering made no difference to any caller — which is the wrong way round. Everything that only wants "not
available" writes `!bytes || bytes === OVERSIZE` and is unchanged — `dvid/skeletons.ts` is the
one such caller. See [widgets-explore.md](widgets-explore.md) for what the tile does with it.

That is what makes thumbnails possible. `fetchCoarseMesh` takes `dvid-ngmesh` under
`THUMBNAIL_MAX_FLAT_BYTES` and still refuses `legacy`, and the asymmetry is deliberate: the question
is whether the **download** can be bounded, not whether the format has levels. A DVID body is one
key a cut-off can stop; a legacy body is a manifest plus N fragments already mostly spent by the
time a ceiling could bite. Worth having rather than theoretical — sampled on mushroombody, 40
random bodies: **median 16 kB, p90 92 kB, max 487 kB**, so a page of 25 is about 0.4 MB, less
than hemibrain's coarsest *precomputed* level costs. A repo whose bodies are the 107 MB kind
draws placeholders instead, at the flat ceiling apiece rather than 107.

### Where it plugs in

`MeshSource` gained a `readBody?: MeshBodyReader` port rather than `fetchMeshes` gaining a
`switch`, because **`data/dvid` knows about precomputed and precomputed must not know about
DVID** — a switch would have put a `data/dvid` import in that file and stood the layering on its
head for one line. It is a module-level function, never a closure: a `MeshSource` is held for the
life of a dataset in `NeuPrintSource`'s state.

**The port takes the whole source, not `source.base`.** Handing a reader one field back off the
object it is attached to fits DVID's meshes, which need only the URL, and stops fitting at the
second instance: a DVID skeleton store carries a voxel scale as well, and a credential is a third
thing a reader will have to reach. Passing the source is what lets the same signature be the
skeleton port, instead of the mirror hitting that wall on its first call site — and it keeps the
reader stateless as well as module-level, which are not in tension.

In `meshSourceFromState`, DVID is tried **last**, only once no object store answered. The
preference order among precomputed candidates is measured (see above — preferring the wrong one
downloaded male-CNS at full resolution with nothing failing), and a dataset publishing both
should keep taking the pyramid. `meshCandidateUrl`'s rule — the location must be an object
store — is untouched and still exactly right; it is what stops a `dvid://` being mapped onto a
bucket host and reported as every neuron missing.

### Auth

These deployments are unauthenticated today. The token is threaded from the start and nothing
stores one yet: `DvidOptions` carries it, `authHeaders` is the one place that knows the header's
spelling, and 401/403 becomes a sentence saying the deployment wants a credential rather than
surfacing as "could not read". A Connections field fills `token` and no other file changes.

### What is not built

The **Neuroglancer Source node does not accept `dvid://` yet**, so a DVID server that no neuPrint
deployment points at is not reachable from the canvas. Everything funnels through
`PrecomputedSource.describe()` → `probePrecomputed`, and skeletons additionally need a port on
`SkeletonSource` mirroring `MeshBodyReader`, since `fetchSkeletons` takes a precomputed source
and DVID's is a different shape.

**No public DVID has both the `<segmentation>_skeletons` convention resolving and a populated
store**, which is why the skeleton decode is tested against a real-bytes fixture rather than
live: `AL-VA1v` has 192 real skeletons under a legacy prefix with no segmentation behind it, and
`hemibrain-flattened` resolves the convention with an empty store (`keyrange` answers `[]`).
`live.test.ts` covers both ends — the refusal, and opening a real store with a real scale.
