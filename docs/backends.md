# The five backends

Everything under `src/data` that talks to somebody else's server.

The shared material — the geometry cache and streaming — is below; each backend's record is
its own file:

## [backends-neuprint.md](backends-neuprint.md) — neuPrint

- [neuPrint](backends-neuprint.md#neuprint)
  - [A connection's regions, and what a weight is a fraction of](backends-neuprint.md#a-connections-regions-and-what-a-weight-is-a-fraction-of)
  - [What else a connection carries, and how to find out](backends-neuprint.md#what-else-a-connection-carries-and-how-to-find-out)
  - [The same totals per group, for a type-collapsed traversal](backends-neuprint.md#the-same-totals-per-group-for-a-type-collapsed-traversal)
  - [A `SynapseSet` is per partner, so a T-bar comes back more than once](backends-neuprint.md#a-synapseset-is-per-partner-so-a-t-bar-comes-back-more-than-once)
  - [A skeleton's soma is `somaLocation`, snapped within 2 µm](backends-neuprint.md#a-skeletons-soma-is-somalocation-snapped-within-2-µm)
  - [Signing in through DatasetGateway](backends-neuprint.md#signing-in-through-datasetgateway)

## [backends-cave.md](backends-cave.md) — CAVE: deployments, sign-in, listing, tables, discovery

- [CAVE](backends-cave.md#cave)
  - [A deployment is a global server, and each has its own token](backends-cave.md#a-deployment-is-a-global-server-and-each-has-its-own-token)
  - [Signing in, and why a static page can](backends-cave.md#signing-in-and-why-a-static-page-can)
  - [The datastack listing is a fact about the credential, so its peek is gated on one](backends-cave.md#the-datastack-listing-is-a-fact-about-the-credential-so-its-peek-is-gated-on-one)
  - [A refusal about a datastack nobody asked for must not raise a credential alarm](backends-cave.md#a-refusal-about-a-datastack-nobody-asked-for-must-not-raise-a-credential-alarm)
  - [neuPrint is queried; CAVE is downloaded](backends-cave.md#neuprint-is-queried-cave-is-downloaded)
  - [The 64-bit problem, at the other end of the seam](backends-cave.md#the-64-bit-problem-at-the-other-end-of-the-seam)
  - [The row cap is a per-deployment number, and counting is the only tell](backends-cave.md#the-row-cap-is-a-per-deployment-number-and-counting-is-the-only-tell)
  - [A synapse table is pre→post links, so there is no presynaptic site to collapse onto](backends-cave.md#a-synapse-table-is-prepost-links-so-there-is-no-presynaptic-site-to-collapse-onto)
  - [A datastack does not describe itself](backends-cave.md#a-datastack-does-not-describe-itself)
  - [A reference table has no root id in it anywhere](backends-cave.md#a-reference-table-has-no-root-id-in-it-anywhere)
  - [A datastack still does not describe itself](backends-cave.md#a-datastack-still-does-not-describe-itself)
  - [Endpoint shapes that are not what a reasonable person would guess](backends-cave.md#endpoint-shapes-that-are-not-what-a-reasonable-person-would-guess)
  - [Discovery: what is in a datastack](backends-cave.md#discovery-what-is-in-a-datastack)
  - [What it costs, and what it declines](backends-cave.md#what-it-costs-and-what-it-declines)
  - [Segment properties, and what they unlock](backends-cave.md#segment-properties-and-what-they-unlock)
  - [Smaller decisions](backends-cave.md#smaller-decisions)
  - [What is not done](backends-cave.md#what-is-not-done)

## [backends-cave-geometry.md](backends-cave-geometry.md) — CAVE meshes and skeletons

- [The flat segmentation beside a materialization, which CAVE does not mention](backends-cave-geometry.md#the-flat-segmentation-beside-a-materialization-which-cave-does-not-mention)
- [A thumbnail from the chunk graph, where there is no mesh cheap enough to draw](backends-cave-geometry.md#a-thumbnail-from-the-chunk-graph-where-there-is-no-mesh-cheap-enough-to-draw)
- [A graphene fragment name is an instruction, not a path — and half of it is a `Range` header](backends-cave-geometry.md#a-graphene-fragment-name-is-an-instruction-not-a-path--and-half-of-it-is-a-range-header)
- [`Detail` and `Downsample`, and why one control could not be both](backends-cave-geometry.md#detail-and-downsample-and-why-one-control-could-not-be-both)
- [What stopped a full-resolution neuron drawing was the draw call, not the memory](backends-cave-geometry.md#what-stopped-a-full-resolution-neuron-drawing-was-the-draw-call-not-the-memory)
- [A lone neuron does not price a set, and the one you measure is the big one](backends-cave-geometry.md#a-lone-neuron-does-not-price-a-set-and-the-one-you-measure-is-the-big-one)
- [Decimating over the fragments, rather than over a copy of them](backends-cave-geometry.md#decimating-over-the-fragments-rather-than-over-a-copy-of-them)
- [Three routes to a skeleton, and which one answered is the user's to choose](backends-cave-geometry.md#three-routes-to-a-skeleton-and-which-one-answered-is-the-users-to-choose)
- [Skeletons come from the level-2 cache, and the capability is per dataset](backends-cave-geometry.md#skeletons-come-from-the-level-2-cache-and-the-capability-is-per-dataset)
- [The skeleton service, which is a third route and answers for one datastack](backends-cave-geometry.md#the-skeleton-service-which-is-a-third-route-and-answers-for-one-datastack)
- [A failed lookup is not an answer — three places that said "none" for the session](backends-cave-geometry.md#a-failed-lookup-is-not-an-answer--three-places-that-said-none-for-the-session)
- [A geometry is the id asked for — why there is no SWC release route](backends-cave-geometry.md#a-geometry-is-the-id-asked-for--why-there-is-no-swc-release-route)

## [backends-catmaid.md](backends-catmaid.md) — CATMAID

- [CATMAID](backends-catmaid.md#catmaid)
  - [The access problem, which decides the module](backends-catmaid.md#the-access-problem-which-decides-the-module)
  - [Credentials are a list, because CATMAID is software rather than a service](backends-catmaid.md#credentials-are-a-list-because-catmaid-is-software-rather-than-a-service)
  - [`type` is derived, because CATMAID has no such field](backends-catmaid.md#type-is-derived-because-catmaid-has-no-such-field)
  - [The numbers, which cut both ways](backends-catmaid.md#the-numbers-which-cut-both-ways)
  - [Traps, each verified rather than assumed](backends-catmaid.md#traps-each-verified-rather-than-assumed)
  - [What it cannot do, and what is not done](backends-catmaid.md#what-it-cannot-do-and-what-is-not-done)

## [backends-precomputed.md](backends-precomputed.md) — Precomputed

- [Precomputed](backends-precomputed.md#precomputed)
  - [One parser for the three spellings of a source](backends-precomputed.md#one-parser-for-the-three-spellings-of-a-source)
  - [What is at the end of a URL, read once](backends-precomputed.md#what-is-at-the-end-of-a-url-read-once)
  - [Skeletons](backends-precomputed.md#skeletons)

## [backends-dvid.md](backends-dvid.md) — DVID

- [DVID](backends-dvid.md#dvid)
  - [Discovery is one narrow question, deliberately](backends-dvid.md#discovery-is-one-narrow-question-deliberately)
  - [Meshes are nanometres and skeletons are voxels](backends-dvid.md#meshes-are-nanometres-and-skeletons-are-voxels)
  - [`.ngmesh` is a format Coda already read](backends-dvid.md#ngmesh-is-a-format-coda-already-read)
  - [The size problem, and why the ceiling had to move](backends-dvid.md#the-size-problem-and-why-the-ceiling-had-to-move)
  - [Where it plugs in](backends-dvid.md#where-it-plugs-in)
  - [Auth](backends-dvid.md#auth)
  - [What is not built](backends-dvid.md#what-is-not-built)

## [backends-zapbench.md](backends-zapbench.md) — ZapBench

- [ZapBench: a released zarr array, not a server](backends-zapbench.md#zapbench-a-released-zarr-array-not-a-server)
  - [Two layouts, and why the reader chooses per request](backends-zapbench.md#two-layouts-and-why-the-reader-chooses-per-request)
  - [The pyramid: a row is a bin](backends-zapbench.md#the-pyramid-a-row-is-a-bin)
  - [The id seam](backends-zapbench.md#the-id-seam)


Not one of the five: NeuronBridge's public bucket (`src/data/neuronbridge`) is read by a node rather
than served through `DataSource`, as ZapBench's is. See [neuronbridge.md](neuronbridge.md).

**Every _neuron_ skeleton and mesh fetch goes through `geometryCache.ts` first.** All three
backends compose their own key and hand it the ids they were asked for; it answers the ones it
holds and calls back with only the remainder, so a node re-running on a changed neuron set
downloads the difference rather than the set. The reasoning, the measurement behind it and what
belongs in a key are in [core.md](core.md#three-caches-and-the-two-controls-that-clear-them) —
read it before adding a fourth backend's geometry path, because getting the key wrong is silent in
both directions: too narrow and nothing ever hits, too broad and a body is served at a detail
level nobody asked for.

**Three of the four fan-outs also stream.** `cachedGeometry`'s `fetch` hands each body over
through `deliver` as it lands rather than returning a map at the end, so a source can build a
partial answer and pass it to `GeometryRequest.onPartial` — see **A partial result** in
[core.md](core.md). neuPrint skeletons, neuPrint meshes and CAVE meshes are all one independent
request per body and stream from the first arrival. Two do not:

- **Precomputed multi-resolution meshes** stream only their fragment sweep. `chooseLod` sums
  `totalBytes` across the whole batch, so no fragment can be requested until the last manifest
  has landed — and measured against hemibrain at 300 bodies, the manifest sweep is 1,913 ms of a
  2,381 ms cold run. A re-run with the manifests already cached streams from the start, because
  they get their own cache entry and are level-independent. Breaking the barrier properly means
  changing what `Detail` *means* — a per-body byte budget, or a level committed from a prefix of
  the manifests — which is a semantics decision, not plumbing.
- **CAVE level-2 skeletons cannot stream at all.** `readL2Skeletons` is not a per-neuron fan-out
  that happens to be batched: it reads every neuron's chunk graph, pools the chunk ids across the
  whole set, and reads their coordinates in as few requests as it takes. No skeleton exists until
  that pooled read lands. Making it streamable means reading attributes per neuron — more
  requests for a slower result, which is the opposite of the trade that made the batching worth
  writing.

A source that streams starts its **attribute** query alongside the geometry and hands the promise
to `cachedGeometry` as `readyBefore`; nothing publishes until it settles. A partial assembled
without those rows carries a null `type` for every body, so a scene set to colour by type fills
in grey and then restyles itself wholesale when the last body arrives — and awaiting them
*before* the fetch is worse, since on CAVE's cold path that is a 139,255-row index build standing
between the user and the first byte of geometry.

The rule is in the shared layer because all three sources need it and each had grown its own
spelling of "has it landed" — a boolean beside a nullable result, a shadow copy of the awaited
value, and a re-derivation of the condition that decided whether to fetch at all. Settled rather
than fulfilled: a source that could not label its bodies should still draw them.

**`fetchRoiMeshes` is the exception, and it is a gap rather than a decision.** Region shells are
the largest download in the app — 29 MB for hemibrain's primary set, 62 MB for male-CNS's — and
adding one region to the `ROI Meshes` picker re-fetches every other one, which is exactly the case
the cache was written for at ten times the bytes per item. It needs `refresh`/`onFetched` on
`RoiMeshRequest` (which `GeometryRequest` has and this does not), a per-region key in
`NeuPrintSource.fetchRoiMeshes`, and `dataCache: true` on the node. Note `roiOutlines.ts` caches
only the *derived 2D outlines*, under a UI-layer key, so the ROI Viewer and the node share
nothing today.
